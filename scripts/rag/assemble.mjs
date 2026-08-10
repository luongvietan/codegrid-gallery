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
  scopeCss, rewriteTokens, buildPage, containFixed, rewriteAssetPaths, isEsModule, bareImportsOf,
} from './assembly.mjs';
import { pickReactEntry, isBareSpecifier, buildImportMap, retargetMount, rootIdFor } from './react-lib.mjs';

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
const outDirFor = (opts) => opts.out || path.join(opts.dir, 'site');

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

/**
 * Bundle a React project into one module, leaving every dependency to the import
 * map. esbuild resolves the project's own files; nothing is installed, which
 * matters because the ingest never captured node_modules.
 */
async function bundleReact(projectDir, entry, slot) {
  let esbuild;
  try { esbuild = await import('esbuild'); }
  catch { throw new Error('React picks need esbuild: npm i -D esbuild'); }

  const bare = new Set();
  const result = await esbuild.build({
    entryPoints: [path.join(projectDir, entry)],
    bundle: true, write: false, format: 'esm', target: 'es2020',
    // outdir is required even with write:false — without it esbuild refuses to
    // split imported CSS out of the JS, which every CRA project does.
    outdir: 'dist',
    jsx: 'automatic', loader: { '.js': 'jsx', '.jsx': 'jsx', '.png': 'dataurl', '.jpg': 'dataurl', '.jpeg': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl', '.gif': 'dataurl' },
    logLevel: 'silent',
    plugins: [{
      name: 'externalise-bare',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (!isBareSpecifier(args.path)) return null;
          bare.add(args.path);
          return { path: args.path, external: true };
        });
      },
    }],
  });

  const js = result.outputFiles.filter((f) => f.path.endsWith('.js')).map((f) => f.text).join('\n');
  const css = result.outputFiles.filter((f) => f.path.endsWith('.css')).map((f) => f.text).join('\n');
  return { js: retargetMount(js, rootIdFor(slot)), css, bare: [...bare] };
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

  const bySlot = new Map();
  const bareSpecs = [];
  const externalCss = [];
  const externalJs = [];
  const skipped = [];

  for (const pick of plan.picks || []) {
    const cardFile = path.join(opts.corpus, 'cards', `${pick.id}.json`);
    const recFile = path.join(opts.corpus, pick.id, '.ingest.json');
    if (!fs.existsSync(cardFile) || !fs.existsSync(recFile)) { skipped.push({ ...pick, why: 'not in the corpus' }); continue; }
    const card = JSON.parse(fs.readFileSync(cardFile, 'utf8'));
    const record = JSON.parse(fs.readFileSync(recFile, 'utf8'));

    // Next owns routing, layout and (app router) server rendering. `app/page.js`
    // is a module in a framework, not a component you can mount into a section,
    // so these stay out rather than being half-supported.
    if (card.framework === 'next' || card.framework === 'vue' || card.framework === 'svelte') {
      skipped.push({ ...pick, why: `${card.framework} needs its own runtime — a page is not a mountable component` });
      continue;
    }

    // The card's framework comes from the archive's own label, which is wrong
    // often enough to matter: a project tagged react whose files are index.html
    // + script.js + styles.css is a vanilla page. Trust what is on disk.
    const filePaths = (record.files || []).map((f) => f.path);
    const reactEntry = pickReactEntry(filePaths);
    const looksReact = !!reactEntry && filePaths.some((f) => /\.(jsx|tsx)$/i.test(f) || /(^|\/)src\//i.test(f));

    if (card.framework === 'react' && looksReact) {
      const projectDir = path.join(opts.corpus, pick.id);
      const entry = reactEntry;
      try {
        const built = await bundleReact(projectDir, entry, pick.slot);
        built.bare.forEach((b) => bareSpecs.push(b));
        const scope = `[data-slot="${pick.slot}"]`;
        const rewrite = (plan.rewrites || {})[pick.id] || {};
        bySlot.set(pick.slot, {
          slot: pick.slot,
          html: `<div id="${rootIdFor(pick.slot)}"></div>`,
          css: scopeCss(containFixed(rewriteTokens(built.css, rewrite)), scope),
          module: built.js,
          origin: 'reused',
        });
        console.log(`  ${pick.slot.padEnd(12)} ${pick.id.slice(0, 40)} · react bundle ${Math.round(built.js.length / 1024)} KB, ${built.bare.length} dep(s)`);
      } catch (e) {
        skipped.push({ ...pick, why: `react bundle failed: ${e.message.split('\n')[0].slice(0, 120)}` });
      }
      continue;
    }
    if (card.framework !== 'vanilla' && !entryHtmlOf(record)) {
      skipped.push({ ...pick, why: `labelled ${card.framework} and has no HTML entry to fall back on` });
      continue;
    }

    const entry = entryHtmlOf(record);
    if (!entry) { skipped.push({ ...pick, why: 'no HTML entry file' }); continue; }

    const projectDir = path.join(opts.corpus, pick.id);
    const html = fs.readFileSync(path.join(projectDir, entry), 'utf8');
    const ext = extractExternals(html);
    externalCss.push(ext.css);
    externalJs.push(ext.js);

    const local = inlineLocalAssets(html, projectDir, entry);
    if (isEsModule(local.js)) bareImportsOf(local.js).forEach((b) => bareSpecs.push(b));
    const rewrite = (plan.rewrites || {})[pick.id] || {};
    const scope = `[data-slot="${pick.slot}"]`;

    // Copy this component's images and re-point its urls at the copies. Paths
    // are kept relative to the component's entry file, which is what its markup
    // was written against.
    const assetPrefix = `assets/${pick.slot}`;
    const entryDir = path.dirname(entry);
    let copied = 0;
    for (const img of record.images || []) {
      let rel = entryDir && img.path.startsWith(`${entryDir}/`) ? img.path.slice(entryDir.length + 1) : img.path;
      // Vite (and Next, and CRA) serve `public/` from the document root, which is
      // why these pages reference `/hero.jpg` for a file stored at
      // `public/hero.jpg`. Dropping the segment is what makes those urls resolve.
      rel = rel.replace(/^public\//, '');
      const dest = path.join(outDirFor(opts, plan), assetPrefix, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(projectDir, img.path), dest);
      copied++;
    }

    bySlot.set(pick.slot, {
      slot: pick.slot,
      html: rewriteAssetPaths(rewriteTokens(extractBodyInner(html), rewrite), assetPrefix),
      // Global components (a cursor, a smooth-scroll driver) keep their fixed
      // layers; a section's must be pinned to the section.
      css: scopeCss(rewriteAssetPaths(card.scope === 'global' ? rewriteTokens(local.css, rewrite) : containFixed(rewriteTokens(local.css, rewrite)), assetPrefix), scope),
      // A page that ships ESM must stay a module: an IIFE-wrapped import throws
      // and kills the section without touching the rest of the page.
      ...(isEsModule(local.js) ? { module: local.js } : { js: local.js }),
      origin: 'reused',
    });
    console.log(`  ${pick.slot.padEnd(12)} ${pick.id.slice(0, 46)} · ${local.css.length} B css, ${local.js.length} B js, ${copied} image(s)`);
  }

  // Sections written by generate.mjs, in the page's own design language rather
  // than transplanted from a finished design.
  const genDir = path.join(opts.dir, 'generated');
  if (fs.existsSync(genDir)) {
    for (const f of fs.readdirSync(genDir).filter((x) => x.endsWith('.json'))) {
      const g = JSON.parse(fs.readFileSync(path.join(genDir, f), 'utf8'));
      const scope = `[data-slot="${g.slot}"]`;
      bySlot.set(g.slot, { slot: g.slot, html: g.html, css: scopeCss(g.css || '', scope), js: g.js || '', origin: 'written' });
      console.log(`  ${g.slot.padEnd(12)} (written) · ${(g.css || '').length} B css, ${(g.js || '').length} B js`);
    }
  }

  for (const u of plan.unfilled || []) {
    if (!bySlot.has(u.key)) skipped.push({ slot: u.key, id: '(none)', why: `left for fresh code — ${u.reason}` });
  }

  // Page order is plan order, whichever way a slot was filled.
  const order = (plan.plan?.slots || []).map((s) => s.key);
  const sections = [...bySlot.values()].sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));

  if (!sections.length) { console.error('Nothing assembled — every pick was skipped.'); process.exit(1); }

  const outDir = outDirFor(opts, plan);
  fs.mkdirSync(outDir, { recursive: true });
  const page = buildPage({
    title: plan.plan?.title || 'Composed page',
    tokens: plan.tokens || {},
    externals: { css: dedupeExternals(externalCss), js: dedupeExternals(externalJs) },
    sections,
    importMap: bareSpecs.length ? buildImportMap(bareSpecs) : null,
  });
  fs.writeFileSync(path.join(outDir, 'index.html'), page);

  const notes = [
    `# Assembly report — ${plan.plan?.title || ''}`, '',
    `${sections.length} section(s) assembled into index.html: ${sections.filter((s) => s.origin === 'reused').map((s) => s.slot).join(', ') || 'none'} reused, ${sections.filter((s) => s.origin === 'written').map((s) => s.slot).join(', ') || 'none'} written.`, '',
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
