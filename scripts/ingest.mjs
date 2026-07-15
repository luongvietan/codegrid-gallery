#!/usr/bin/env node
// scripts/ingest.mjs — "learn 100% of the gallery code" harness.
//
// Reads data/index.json (the ledger of all 422 gallery projects), downloads each
// project's CODE.zip from the public R2 bucket, extracts every *source* file
// (skipping node_modules / build output / binaries), and writes a searchable
// local corpus plus a manifest and AI-agent guide. Idempotent + resumable.
//
//   node scripts/ingest.mjs plan               # offline: print the full download plan
//   node scripts/ingest.mjs                     # download + extract + index everything
//   node scripts/ingest.mjs --limit 5           # first 5 projects (smoke test)
//   node scripts/ingest.mjs --force             # re-ingest even if already done
//   node scripts/ingest.mjs --base <url> --out <dir> --concurrency 8
//
// Real downloads must run where the R2 bucket is reachable (your machine or CI);
// from inside a sandbox with an egress policy the bucket may be blocked.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planDownloads, extractZip, partitionEntries, summarizeProject, aggregate,
  safeRelPath, langOf, humanBytes,
} from './ingest-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = path.join(ROOT, 'data', 'index.json');
// Public read-only bucket, same value as .env.example. Override with --base or
// the NEXT_PUBLIC_ASSET_BASE env var.
const DEFAULT_BASE = process.env.NEXT_PUBLIC_ASSET_BASE
  || 'https://pub-2c8291ac249e456c8e906fe5f4aed9c9.r2.dev';

function parseArgs(argv) {
  const opts = { mode: 'run', base: DEFAULT_BASE, out: path.join(ROOT, 'corpus'),
    concurrency: 6, limit: 0, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'plan' || a === 'run') opts.mode = a;
    else if (a === '--force') opts.force = true;
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--concurrency') opts.concurrency = Math.max(1, +argv[++i] || 6);
    else if (a === '--limit') opts.limit = Math.max(0, +argv[++i] || 0);
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return opts;
}

async function download(url, tries = 4) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'codegrid-ingest/1.0' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length === 0) throw new Error('empty download');
      return buf;
    } catch (e) {
      if (attempt === tries) throw new Error(`download failed (${e.message})`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1))); // 1s,2s,4s
    }
  }
}

/** Extract one downloaded zip into <out>/<id>/, returning its manifest record. */
function writeProject(buf, item, out) {
  const dir = path.join(out, item.id);
  fs.rmSync(dir, { recursive: true, force: true });
  const entries = extractZip(buf);
  const dataByName = new Map(entries.map((e) => [e.name, e]));
  const { kept, skipped } = partitionEntries(entries.map((e) => ({ name: e.name, size: e.size })));

  const written = [];
  const failed = [];
  for (const k of kept) {
    const e = dataByName.get(k.name);
    const rel = safeRelPath(k.name);
    if (!rel || !e || e.data == null) { failed.push({ name: k.name, error: e?.error || 'unsafe path' }); continue; }
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.data);
    written.push({ path: rel, lang: k.lang, size: e.data.length });
  }

  const sum = summarizeProject(written.map((w) => ({ size: w.size, lang: w.lang })));
  const record = {
    id: item.id, folder: item.folder, title: item.title ?? null, type: item.type,
    entryHtml: item.entryHtml ?? null, status: 'ok',
    zipBytes: buf.length, expectedZipBytes: item.expectedZipBytes ?? null,
    fileCount: sum.fileCount, textBytes: sum.textBytes, byLang: sum.byLang,
    skippedBinary: skipped.length, failed,
    files: written.sort((a, b) => a.path.localeCompare(b.path)),
  };
  fs.writeFileSync(path.join(dir, '.ingest.json'), JSON.stringify(record));
  return record;
}

/** Run `worker` over `items` with at most `n` in flight. Order-preserving results. */
async function pool(items, n, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return results;
}

function renderCorpusMd(manifest) {
  const t = manifest.totals;
  const langRows = Object.entries(t.byLang).sort((a, b) => b[1] - a[1])
    .map(([l, c]) => `| ${l} | ${c} |`).join('\n');
  const byType = Object.entries(t.byType).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`).join(' · ');
  const projRows = manifest.projects.filter((p) => p.status === 'ok')
    .sort((a, b) => (b.fileCount || 0) - (a.fileCount || 0))
    .map((p) => `| \`${p.id}\` | ${p.type} | ${p.fileCount} | ${humanBytes(p.textBytes)} | ${p.entryHtml ?? '—'} |`)
    .join('\n');
  return `# CodeGrid corpus

Generated ${manifest.generatedAt} from \`data/index.json\` · source: ${manifest.base}

**${t.projects} projects · ${t.files} source files · ${humanBytes(t.textBytes)} of code** (${byType})

## Languages

| Language | Files |
|---|---|
${langRows}

## How to use this corpus

- Every project's source lives in \`corpus/<id>/…\` exactly as shipped in its \`CODE.zip\`
  (minus \`node_modules\`, build output, and binaries — see each project's \`.ingest.json\`).
- \`corpus/manifest.json\` — machine-readable index of every project + file.
- \`corpus/search-index.jsonl\` — one line per source file (id, path, lang, type).
- Search everything: \`node scripts/corpus-query.mjs "gsap horizontal scroll"\`.
- Read \`corpus/AGENTS.md\` for how an AI agent should navigate + learn from this.

## Projects (by file count)

| id | type | files | code | entry |
|---|---|---|---|---|
${projRows}
`;
}

function renderAgentsMd(manifest) {
  const t = manifest.totals;
  return `# Reading this corpus as an AI agent

This directory is the **complete source** of every code snippet shown in the CodeGrid
gallery: ${t.projects} projects, ${t.files} files, ${humanBytes(t.textBytes)} of HTML/CSS/JS/React/Next.js.
Treat it as your knowledge base for "how is <effect/pattern> built".

## Ground rules

1. **Source of truth is the files on disk** under \`corpus/<id>/\`, not your memory.
   When asked how something is done, find a real example here and cite \`corpus/<id>/<path>\`.
2. **Find before you read.** Don't read whole projects blindly:
   - Full-text + ranked: \`node scripts/corpus-query.mjs "sticky cursor follow"\`
   - Or grep directly: \`rg -n "IntersectionObserver" corpus/\`
   - Metadata/filter: read \`corpus/manifest.json\` (per-project langs, entry file, counts).
3. **Respect project type** (\`type\` in the manifest): \`html\` (static), \`react\`, \`nextjs\`.
   For \`nextjs\`, the entry is usually \`src/app/page.*\`; for \`html\`, the \`entryHtml\` field.
4. **Learn patterns, cite provenance.** Community code varies in quality — prefer patterns
   that recur across several projects, and always name the project you took it from.

## Fast recipes

- "Show me every GSAP ScrollTrigger example": \`node scripts/corpus-query.mjs "ScrollTrigger"\`
- "Which projects use Three.js?": \`rg -l "three" corpus/**/package.json\`
- "Summarize one project": read \`corpus/<id>/.ingest.json\` then its entry file.

## Optional: pre-digested notes

If \`corpus/<id>/LEARNED.md\` exists, it's an LLM-written summary of what that project
teaches (generated by \`scripts/learn.mjs\`). Use it as a fast index, but verify against
the real files before relying on any claim.
`;
}

function writeCorpus(out, base, records) {
  const okRecords = records.filter(Boolean);
  const totals = aggregate(okRecords);
  const manifest = {
    generatedAt: new Date().toISOString(),
    base,
    totals,
    projects: okRecords.map((r) => ({
      id: r.id, folder: r.folder, title: r.title, type: r.type, status: r.status,
      entryHtml: r.entryHtml, fileCount: r.fileCount, textBytes: r.textBytes,
      byLang: r.byLang, error: r.error,
    })),
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const lines = [];
  for (const r of okRecords) {
    if (r.status !== 'ok') continue;
    for (const f of r.files || []) {
      lines.push(JSON.stringify({ id: r.id, type: r.type, title: r.title, path: f.path, lang: f.lang, size: f.size }));
    }
  }
  fs.writeFileSync(path.join(out, 'search-index.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));
  fs.writeFileSync(path.join(out, 'CORPUS.md'), renderCorpusMd(manifest));
  fs.writeFileSync(path.join(out, 'AGENTS.md'), renderAgentsMd(manifest));
  return manifest;
}

function printPlan(plan, base) {
  const withZip = plan.filter((p) => p.url);
  const totalBytes = withZip.reduce((s, p) => s + (p.expectedZipBytes || 0), 0);
  const byType = plan.reduce((m, p) => ((m[p.type] = (m[p.type] || 0) + 1), m), {});
  console.log(`Plan · base=${base}`);
  console.log(`  projects:      ${plan.length}`);
  console.log(`  with a zip:    ${withZip.length}`);
  console.log(`  by type:       ${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(' · ')}`);
  console.log(`  download size: ${humanBytes(totalBytes)} (compressed zips)`);
  console.log(`  example url:   ${withZip[0]?.url ?? '(none)'}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  let plan = planDownloads(index, opts.base);
  if (opts.limit) plan = plan.slice(0, opts.limit);

  if (opts.mode === 'plan') {
    fs.mkdirSync(opts.out, { recursive: true });
    fs.writeFileSync(path.join(opts.out, 'PLAN.json'), JSON.stringify({ base: opts.base, count: plan.length, plan }, null, 2));
    printPlan(plan, opts.base);
    console.log(`\nWrote ${path.relative(ROOT, path.join(opts.out, 'PLAN.json'))}. Run without \`plan\` to download + extract.`);
    return;
  }

  fs.mkdirSync(opts.out, { recursive: true });
  let done = 0;
  const records = await pool(plan, opts.concurrency, async (item) => {
    const marker = path.join(opts.out, item.id, '.ingest.json');
    if (!opts.force && fs.existsSync(marker)) {
      done++;
      return JSON.parse(fs.readFileSync(marker, 'utf8'));
    }
    if (!item.url) { done++; return { id: item.id, folder: item.folder, type: item.type, status: 'error', error: 'no zip in index' }; }
    try {
      const buf = await download(item.url);
      const rec = writeProject(buf, item, opts.out);
      console.log(`[${++done}/${plan.length}] ${item.id} · ${rec.fileCount} files · ${humanBytes(rec.textBytes)}`);
      return rec;
    } catch (e) {
      console.error(`[${++done}/${plan.length}] ${item.id} · FAILED: ${e.message}`);
      return { id: item.id, folder: item.folder, type: item.type, status: 'error', error: e.message };
    }
  });

  const manifest = writeCorpus(opts.out, opts.base, records);
  const failed = records.filter((r) => r && r.status !== 'ok');
  console.log(`\nCorpus ready: ${manifest.totals.projects} projects · ${manifest.totals.files} files · ${humanBytes(manifest.totals.textBytes)}.`);
  if (failed.length) console.log(`${failed.length} project(s) failed — re-run to retry (resume skips finished ones).`);
  console.log(`Wrote ${path.relative(ROOT, opts.out)}/{manifest.json, search-index.jsonl, CORPUS.md, AGENTS.md}`);
}

// Exported for the offline end-to-end test (scripts/ingest.test.mjs).
export { writeProject, writeCorpus, renderCorpusMd, renderAgentsMd };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
}
