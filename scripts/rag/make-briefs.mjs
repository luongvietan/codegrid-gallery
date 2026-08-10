#!/usr/bin/env node
// scripts/rag/make-briefs.mjs — generate an eval set grounded in the real corpus.
//
// Hand-written briefs went stale the moment the corpus grew: their expect_id was
// chosen against a 20-card pool, and a brief can describe something the archive
// does not actually contain. Both make the score say more about the brief writer
// than about retrieval.
//
// This reads a card's SOURCE CODE — never its card — and asks for the one-line
// brief a designer would type to find that page. The annotator and the brief
// writer look at the same artifact through different windows, so a hit means the
// two independently described the same thing, not that a paraphrase matched.
//
//   LLM_PROVIDER=deepseek node scripts/rag/make-briefs.mjs --n 30 --out docs/harness/eval-briefs.generated.json
//   node scripts/rag/eval.mjs docs/harness/eval-briefs.generated.json --judge
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isTextFile } from '../ingest-lib.mjs';
import { resolveLlm, createChat, extractJson } from './llm.mjs';
import { selectDiverse } from './retrieval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_SOURCE = 20000;

/** Deterministic PRNG so a run is reproducible from --seed. Pure. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildBriefPrompt(source) {
  return `Below is the source of one front-end page. Imagine you are a DESIGNER who saw this page, liked it, and now wants to find something like it in a component library. Write the search you would type.

Return ONLY: {"query": "..."}

RULES:
1. One sentence, 8-18 words, describing the VISIBLE RESULT and how it MOVES.
2. Designer vocabulary. No library names (gsap, swiper, three), no class names, no file names.
3. No brand names and no copy from the page — that text gets replaced on reuse, so searching by it is useless. Describe form and motion instead.
4. Be specific enough that it would not equally describe every page of this kind: name the layout, the direction of movement, or what triggers it.

SOURCE:
${source}`;
}

export function validateGenBrief(obj) {
  const errors = [];
  const q = obj?.query;
  if (typeof q !== 'string' || !q.trim()) errors.push('query: must be a non-empty string');
  else {
    const words = q.trim().split(/\s+/).length;
    if (words < 6 || words > 24) errors.push(`query: expected roughly 8-18 words, got ${words}`);
  }
  return { ok: errors.length === 0, errors };
}

function readSource(corpus, id) {
  const dir = path.join(corpus, id);
  const recPath = path.join(dir, '.ingest.json');
  if (!fs.existsSync(recPath)) return '';
  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  const files = (rec.files || []).map((f) => f.path);
  const entry = rec.entryHtml && files.includes(rec.entryHtml) ? rec.entryHtml : null;
  const ordered = [entry, ...files.filter((p) => p !== entry)].filter(Boolean);
  let used = 0;
  const parts = [];
  for (const rel of ordered) {
    if (!isTextFile(rel) || used >= MAX_SOURCE) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { continue; }
    const slice = text.slice(0, MAX_SOURCE - used);
    parts.push(`===== ${rel} =====\n${slice}`);
    used += slice.length;
  }
  return parts.join('\n');
}

async function askForBrief(chat, source) {
  const messages = [{ role: 'user', content: buildBriefPrompt(source) }];
  let lastErr = 'unknown';
  for (let i = 0; i < 3; i++) {
    const text = await chat(messages, 4000);
    let obj;
    try { obj = extractJson(text); } catch (e) { lastErr = e.message; messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Not valid JSON (${e.message}). Return ONLY {"query": "..."}.` }); continue; }
    const { ok, errors } = validateGenBrief(obj);
    if (ok) return obj.query.trim();
    lastErr = errors.join('; ');
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Fix ONLY these:\n- ${errors.join('\n- ')}` });
  }
  throw new Error(`brief generation failed: ${lastErr}`);
}

function parseArgs(argv) {
  const o = { corpus: path.join(ROOT, 'corpus'), n: 30, seed: 7, concurrency: 5, out: path.join(ROOT, 'docs/harness/eval-briefs.generated.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--n') o.n = Math.max(1, +argv[++i] || 30);
    else if (a === '--seed') o.seed = +argv[++i] || 7;
    else if (a === '--concurrency') o.concurrency = Math.max(1, +argv[++i] || 5);
    else if (a === '--corpus') o.corpus = path.resolve(argv[++i]);
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cardsDir = path.join(opts.corpus, 'cards');
  if (!fs.existsSync(cardsDir)) { console.error('No cards. Run annotate.mjs first.'); process.exit(1); }
  const cards = fs.readdirSync(cardsDir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(cardsDir, f), 'utf8')));

  // Shuffle deterministically, then spread across (type, framework, lib, aesthetic)
  // so the eval is not 30 heroes — the same diversity rule the eval harness uses.
  const rnd = mulberry32(opts.seed);
  const shuffled = [...cards].sort(() => rnd() - 0.5);
  const picked = selectDiverse(shuffled, opts.n);

  const chat = await createChat(resolveLlm());
  console.log(`Writing ${picked.length} briefs from source (never from the cards)...`);

  const out = [];
  const queue = [...picked];
  async function worker() {
    while (queue.length) {
      const card = queue.shift();
      const source = readSource(opts.corpus, card.id);
      if (!source.trim()) continue;
      try {
        const query = await askForBrief(chat, source);
        out.push({ query, expect_id: card.id, filters: { compType: card.comp_type } });
        console.log(`  ${card.comp_type.padEnd(14)} ${query}`);
      } catch (e) {
        console.error(`  ${card.id} · FAILED: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, picked.length) }, worker));

  out.sort((a, b) => a.expect_id.localeCompare(b.expect_id));
  fs.writeFileSync(opts.out, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${out.length} briefs to ${path.relative(ROOT, opts.out)}. Next: node scripts/rag/eval.mjs ${path.relative(ROOT, opts.out)} --judge`);
}

// This module exports helpers that the tests import, so it must not run main()
// on import. pathToFileURL, not string concatenation — see scripts/ingest.mjs.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
}
