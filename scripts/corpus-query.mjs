#!/usr/bin/env node
// scripts/corpus-query.mjs — offline ranked search over the ingested corpus.
// Lets an AI agent (or you) find any pattern across all 422 projects instantly,
// without embeddings or a server.
//
//   node scripts/corpus-query.mjs "gsap scrolltrigger horizontal"
//   node scripts/corpus-query.mjs "cursor follow" --type react --limit 20
//   node scripts/corpus-query.mjs "grid" --lang CSS
//
// Terms are AND-matched across each file's path + contents; results are ranked
// by match density and path relevance. Run `scripts/ingest.mjs` first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function tokenize(q) {
  return String(q).toLowerCase().split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

export function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) { n++; i = hay.indexOf(needle, i + needle.length); }
  return n;
}

/** AND-match `terms` over a document. Every term must appear in the path or the
 *  body; score rewards path hits (+8) and body density (occurrences, capped). */
export function scoreDoc(pathText, content, terms) {
  const hay = pathText.toLowerCase();
  const body = content.toLowerCase();
  let score = 0;
  for (const t of terms) {
    const inPath = hay.includes(t);
    const n = countOccurrences(body, t);
    if (!inPath && n === 0) return { matched: false, score: 0 };
    if (inPath) score += 8;
    score += Math.min(n, 25);
  }
  return { matched: true, score };
}

/** First line (1-indexed) containing any term, with the raw text, or null. */
export function firstMatchLine(content, terms) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lc = lines[i].toLowerCase();
    if (terms.some((t) => lc.includes(t))) return { lineNo: i + 1, text: lines[i].trim().slice(0, 160) };
  }
  return null;
}

function parseArgs(argv) {
  const opts = { terms: [], type: null, lang: null, limit: 12, corpus: path.join(ROOT, 'corpus') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--type') opts.type = argv[++i];
    else if (a === '--lang') opts.lang = argv[++i];
    else if (a === '--limit') opts.limit = Math.max(1, +argv[++i] || 12);
    else if (a === '--corpus') opts.corpus = path.resolve(argv[++i]);
    else opts.terms.push(a);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const terms = tokenize(opts.terms.join(' '));
  if (!terms.length) { console.error('Usage: node scripts/corpus-query.mjs "<query>" [--type html|react|nextjs] [--lang CSS] [--limit N]'); process.exit(2); }

  const indexPath = path.join(opts.corpus, 'search-index.jsonl');
  if (!fs.existsSync(indexPath)) {
    console.error(`No corpus at ${path.relative(ROOT, opts.corpus)}. Run: node scripts/ingest.mjs`);
    process.exit(1);
  }
  const entries = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  const hits = [];
  for (const e of entries) {
    if (opts.type && e.type !== opts.type) continue;
    if (opts.lang && e.lang !== opts.lang) continue;
    const file = path.join(opts.corpus, e.id, e.path);
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const pathText = `${e.id} ${e.title ?? ''} ${e.path}`;
    const { matched, score } = scoreDoc(pathText, content, terms);
    if (!matched) continue;
    hits.push({ ...e, score, snippet: firstMatchLine(content, terms) });
  }

  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const top = hits.slice(0, opts.limit);
  if (!top.length) { console.log(`No matches for "${terms.join(' ')}".`); return; }

  console.log(`${hits.length} file(s) match "${terms.join(' ')}"${opts.type ? ` [type=${opts.type}]` : ''}${opts.lang ? ` [lang=${opts.lang}]` : ''} — top ${top.length}:\n`);
  for (const h of top) {
    console.log(`  ${h.type.padEnd(6)} ${h.id}/${h.path}  (score ${h.score})`);
    if (h.snippet) console.log(`         ${h.snippet.lineNo}: ${h.snippet.text}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
