#!/usr/bin/env node
// scripts/learn.mjs — OPTIONAL LLM layer over the ingested corpus.
//
// For each project in corpus/, asks Claude to write a concise "what this teaches"
// note (techniques, libraries, notable patterns, file guide) to corpus/<id>/LEARNED.md.
// Turns the raw corpus into pre-digested knowledge an agent can skim before reading
// source. Idempotent + resumable (skips projects that already have LEARNED.md).
//
//   npm i @anthropic-ai/sdk            # one-time; kept out of the base install
//   ANTHROPIC_API_KEY=... node scripts/learn.mjs
//   node scripts/learn.mjs --limit 10 --concurrency 3 --force
//
// Runs where the Anthropic API is reachable (your machine or CI). Uses the same
// model Claude Code uses (claude-opus-4-8) via the official SDK.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTextFile } from './ingest-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'claude-opus-4-8';
const MAX_CHARS = 40000; // cap of source fed to the model per project

function parseArgs(argv) {
  const o = { corpus: path.join(ROOT, 'corpus'), limit: 0, concurrency: 3, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (a === '--corpus') o.corpus = path.resolve(argv[++i]);
    else if (a === '--limit') o.limit = Math.max(0, +argv[++i] || 0);
    else if (a === '--concurrency') o.concurrency = Math.max(1, +argv[++i] || 3);
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return o;
}

/** Gather a bounded, entry-first slice of a project's source for the prompt. */
function gatherSource(dir, record) {
  const files = (record.files || []).map((f) => f.path);
  const entry = record.entryHtml && files.includes(record.entryHtml) ? record.entryHtml : null;
  const ordered = [
    ...(entry ? [entry] : []),
    ...files.filter((p) => p !== entry).sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length),
  ];
  let used = 0;
  const parts = [];
  for (const rel of ordered) {
    if (!isTextFile(rel)) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { continue; }
    if (used + text.length > MAX_CHARS) {
      const room = MAX_CHARS - used;
      if (room > 500) parts.push(`\n===== ${rel} (truncated) =====\n${text.slice(0, room)}`);
      break;
    }
    parts.push(`\n===== ${rel} =====\n${text}`);
    used += text.length;
  }
  return parts.join('\n');
}

function buildPrompt(record, source) {
  return `You are cataloguing a front-end code snippet from the CodeGrid gallery so an AI coding agent can learn from it later.

Project: ${record.title ?? record.id}
Type: ${record.type} (html = static site, react/nextjs = component app)
Entry file: ${record.entryHtml ?? '(none)'}

Write a compact Markdown note (no preamble, start at the first heading) with these sections:
## What it builds — 1-2 sentences on the visual/interaction result.
## Techniques & libraries — bullet list of the notable CSS/JS/framework techniques and any third-party libs (GSAP, Three.js, Lenis, etc.), each tied to where it's used.
## Reusable patterns — 2-4 bullets an agent could lift into another project, naming the file.
## File guide — one line per important file: \`path\` — what it contains.
Keep it under 250 words. Base every claim on the source below; if something isn't present, don't invent it.

SOURCE:
${source}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY (or run `ant auth login`) before running learn.mjs.');
    process.exit(1);
  }
  const manifestPath = path.join(opts.corpus, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`No corpus manifest at ${path.relative(ROOT, manifestPath)}. Run: node scripts/ingest.mjs`);
    process.exit(1);
  }

  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    console.error('The Anthropic SDK is not installed. Run: npm i @anthropic-ai/sdk');
    process.exit(1);
  }
  const client = new Anthropic();

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let projects = manifest.projects.filter((p) => p.status === 'ok');
  if (opts.limit) projects = projects.slice(0, opts.limit);

  let done = 0;
  const queue = [...projects];
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      const dir = path.join(opts.corpus, p.id);
      const out = path.join(dir, 'LEARNED.md');
      if (!opts.force && fs.existsSync(out)) { console.log(`[${++done}/${projects.length}] ${p.id} · cached`); continue; }
      const record = JSON.parse(fs.readFileSync(path.join(dir, '.ingest.json'), 'utf8'));
      const source = gatherSource(dir, record);
      if (!source.trim()) { console.log(`[${++done}/${projects.length}] ${p.id} · no source, skipped`); continue; }
      try {
        const resp = await client.messages.create({
          model: MODEL,
          max_tokens: 3000,
          messages: [{ role: 'user', content: buildPrompt(record, source) }],
        });
        const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        fs.writeFileSync(out, `<!-- Generated by scripts/learn.mjs (${MODEL}) -->\n\n${text}\n`);
        console.log(`[${++done}/${projects.length}] ${p.id} · learned (${text.length} chars)`);
      } catch (e) {
        console.error(`[${++done}/${projects.length}] ${p.id} · FAILED: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, projects.length) }, worker));
  console.log(`\nDone. LEARNED.md written across corpus/. Re-run to fill any that failed.`);
}

main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
