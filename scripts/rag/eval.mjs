#!/usr/bin/env node
// scripts/rag/eval.mjs — the "measure before you index 400" harness (DB-free).
//
// Loads embedded cards from disk, runs each brief through the SAME retrieval path
// (hard filters -> cosine rank), and reports top-3 hit rate. Two failing signals
// tell you to fix the SCHEMA (not the model): duplicate near-identical cards, or a
// correct brief that misses because the probes use the wrong vocabulary.
//
//   OPENAI_API_KEY=... node scripts/rag/eval.mjs                       # uses docs/harness/eval-briefs.sample.json
//   OPENAI_API_KEY=... node scripts/rag/eval.mjs my-briefs.json --k 3
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedBatch, embedConfig } from './provider.mjs';
import { rankLocal, topKHit } from './retrieval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const o = { corpus: path.join(ROOT, 'corpus'), briefs: path.join(ROOT, 'docs/harness/eval-briefs.sample.json'), k: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus') o.corpus = path.resolve(argv[++i]);
    else if (a === '--k') o.k = Math.max(1, +argv[++i] || 3);
    else if (!a.startsWith('--')) o.briefs = path.resolve(a);
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return o;
}

function loadCards(cardsDir) {
  const cfg = embedConfig();
  const cards = [];
  for (const f of fs.readdirSync(cardsDir).filter((x) => x.endsWith('.json'))) {
    const c = JSON.parse(fs.readFileSync(path.join(cardsDir, f), 'utf8'));
    if (Array.isArray(c.embedding) && c.embedding.length === cfg.dim) cards.push(c);
  }
  return cards;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cardsDir = path.join(opts.corpus, 'cards');
  if (!fs.existsSync(cardsDir)) { console.error('No cards. Run annotate.mjs then embed.mjs.'); process.exit(1); }
  const cards = loadCards(cardsDir);
  if (!cards.length) { console.error('No embedded cards. Run: node scripts/rag/embed.mjs'); process.exit(1); }
  const briefs = JSON.parse(fs.readFileSync(opts.briefs, 'utf8'));

  const qvecs = await embedBatch(briefs.map((b) => b.query));
  let hits = 0;
  console.log(`Eval: ${briefs.length} briefs over ${cards.length} cards, top-${opts.k}\n`);
  for (let i = 0; i < briefs.length; i++) {
    const b = briefs[i];
    const ranked = rankLocal(cards, qvecs[i], b.filters || {}, Math.max(opts.k, 5));
    const hit = b.expect_id ? topKHit(ranked, b.expect_id, opts.k) : null;
    if (hit) hits++;
    const mark = hit === null ? '—' : hit ? '✓' : '✗';
    const top = ranked.slice(0, opts.k).map((r) => `${r.card.id}(${r.sim.toFixed(2)})`).join(', ');
    console.log(`${mark} "${b.query}"${b.expect_id ? ` [want ${b.expect_id}]` : ''}\n    top${opts.k}: ${top || '(none passed filters)'}`);
  }
  const scored = briefs.filter((b) => b.expect_id).length;
  if (scored) console.log(`\nHit@${opts.k}: ${hits}/${scored} (${(100 * hits / scored).toFixed(0)}%)`);
  console.log('If two cards come back near-identical -> schema lacks discriminating power (tighten description part (a)).');
  console.log('If the right card misses -> probes use code vocabulary, not brief vocabulary (fix annotator rule 3).');
}

main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
