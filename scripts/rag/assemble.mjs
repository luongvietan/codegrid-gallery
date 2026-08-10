#!/usr/bin/env node
// scripts/rag/assemble.mjs — turn a composition's decisions into a page you can open.
//
// compose.mjs decides; this builds. It reads plan.json, pulls each pick's real
// source out of the corpus, scopes its CSS to its section, applies the composer's
// token rewrites, hoists shared CDN tags once, and writes one index.html.
//
//   node scripts/rag/assemble.mjs corpus/compositions/<name>
//   node scripts/rag/assemble.mjs <dir> --out site/       # default: <dir>/site
//
// What it does NOT do: reconcile layout. These are complete pages stacked as
// sections, so the result is a DRAFT — the honest input to critique.mjs, not a
// finished site. React and Next picks are skipped rather than half-supported;
// they need a build step this script deliberately does not have.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  extractBodyInner, extractExternals, dedupeExternals,
  scopeCss, rewriteTokens, buildPage, containFixed,
} from './assembly.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const o = { dir: null, corpus: path.join(ROOT, 'corpus'), out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--corpus') o.corpus = path.resolve(argv[++i]);
    else if (a.startsWith('--')) { console.error(`Unknown argument: ${a}`); process.exit(2); }
    else o.dir = path.resolve(a);
  }
  return o;
}

const readIfExists = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

/** Inline what the page links locally; a CDN url is hoisted, a relative one is a file. */
function inlineLocalAssets(html, projectDir, entryRel) {
  const base = path.dirname(path.join(projectDir, entryRel));
  const css = [];
  const js = [];
  for (const m of html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)) {
    const href = /href=["']([^"']+)["']/i.exec(m[0])?.[1];
    if (!href || /^https?:\/\//i.test(href)) continue;
    css.push(readIfExists(path.join(base, href)));
  }
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    const src = m[1];
    if (/^https?:\/\//i.test(src)) continue;
    js.push(readIfExists(path.join(base, src)));
  }
  // Inline <style> and <script> blocks already living in the document.
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) css.push(m[1]);
  for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) js.push(m[1]);
  return { css: css.filter(Boolean).join('\n'), js: js.filter(Boolean).join('\n') };
}

function entryHtmlOf(record) {
  const files = (record.files || []).map((f) => f.path);
  if (record.entryHtml && files.includes(record.entryHtml)) return record.entryHtml;
  return files.find((f) => f.toLowerCase().endsWith('.html')) || null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dir) {
    console.error('Usage: node scripts/rag/assemble.mjs <composition-dir> [--out dir]');
    process.exit(2);
  }
  const planFile = path.join(opts.dir, 'plan.json');
  if (!fs.existsSync(planFile)) { console.error(`No plan.json in ${opts.dir} — run compose.mjs first.`); process.exit(1); }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));

  const sections = [];
  const externalCss = [];
  const externalJs = [];
  const skipped = [];

  for (const pick of plan.picks || []) {
    const cardFile = path.join(opts.corpus, 'cards', `${pick.id}.json`);
    const recFile = path.join(opts.corpus, pick.id, '.ingest.json');
    if (!fs.existsSync(cardFile) || !fs.existsSync(recFile)) { skipped.push({ ...pick, why: 'not in the corpus' }); continue; }
    const card = JSON.parse(fs.readFileSync(cardFile, 'utf8'));
    if (card.framework !== 'vanilla') { skipped.push({ ...pick, why: `framework "${card.framework}" needs a build step this script does not have` }); continue; }

    const record = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    const entry = entryHtmlOf(record);
    if (!entry) { skipped.push({ ...pick, why: 'no HTML entry file' }); continue; }

    const projectDir = path.join(opts.corpus, pick.id);
    const html = fs.readFileSync(path.join(projectDir, entry), 'utf8');
    const ext = extractExternals(html);
    externalCss.push(ext.css);
    externalJs.push(ext.js);

    const local = inlineLocalAssets(html, projectDir, entry);
    const rewrite = (plan.rewrites || {})[pick.id] || {};
    const scope = `[data-slot="${pick.slot}"]`;

    sections.push({
      slot: pick.slot,
      html: rewriteTokens(extractBodyInner(html), rewrite),
      // Global components (a cursor, a smooth-scroll driver) keep their fixed
      // layers; a section's must be pinned to the section.
      css: scopeCss(card.scope === 'global' ? rewriteTokens(local.css, rewrite) : containFixed(rewriteTokens(local.css, rewrite)), scope),
      js: local.js,
    });
    console.log(`  ${pick.slot.padEnd(12)} ${pick.id.slice(0, 46)} · ${local.css.length} B css, ${local.js.length} B js`);
  }

  for (const u of plan.unfilled || []) skipped.push({ slot: u.key, id: '(none)', why: `left for fresh code — ${u.reason}` });

  if (!sections.length) { console.error('Nothing assembled — every pick was skipped.'); process.exit(1); }

  const outDir = opts.out || path.join(opts.dir, 'site');
  fs.mkdirSync(outDir, { recursive: true });
  const page = buildPage({
    title: plan.plan?.title || 'Composed page',
    tokens: plan.tokens || {},
    externals: { css: dedupeExternals(externalCss), js: dedupeExternals(externalJs) },
    sections,
  });
  fs.writeFileSync(path.join(outDir, 'index.html'), page);

  const notes = [
    `# Assembly report — ${plan.plan?.title || ''}`, '',
    `${sections.length} section(s) assembled into index.html.`, '',
    ...(skipped.length ? ['## Not in the page', '', ...skipped.map((s) => `- **${s.slot}** \`${s.id}\` — ${s.why}`), ''] : []),
    '## Read this before trusting the result', '',
    'Each source is a complete page, stacked here as a section with its CSS scoped',
    'to that section. Layout between sections is NOT reconciled: expect duplicated',
    'full-viewport heights, competing fixed layers, and scroll behaviour that only',
    'made sense when the component owned the whole document. That is what the',
    'critique pass is for.', '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'ASSEMBLY.md'), notes);

  console.log(`\n${sections.length} section(s), ${skipped.length} skipped.`);
  console.log(`Wrote ${path.relative(ROOT, path.join(outDir, 'index.html'))}`);
  console.log(`Next: node scripts/rag/critique.mjs ${path.relative(ROOT, path.join(outDir, 'index.html'))} --composition ${path.relative(ROOT, opts.dir)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exitCode = 1; });
}
