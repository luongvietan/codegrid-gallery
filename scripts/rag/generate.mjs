#!/usr/bin/env node
// scripts/rag/generate.mjs — write the slots the index could not fill.
//
// compose.mjs already says which slots have no admissible component and hands
// each one its top techniques with `seen_in` citations. This turns those into
// code: the model gets the page's tokens, the slot's intent, the technique
// mechanisms and real excerpts from the components that exhibit them, and writes
// a section in the page's own design language.
//
//   LLM_PROVIDER=openai LLM_MODEL=gpt-5.6-luna node scripts/rag/generate.mjs <composition-dir>
//   node scripts/rag/generate.mjs <dir> --slot process --force
//
// Output lands in <dir>/generated/<slot>.json; assemble.mjs picks it up and
// places it in slot order beside the reused components.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isTextFile } from '../ingest-lib.mjs';
import { resolveLlm, createChat } from './llm.mjs';
import { embedBatch, embedConfig } from './provider.mjs';
import { rankTechniques } from './retrieval.mjs';
import { generateSection } from './generation.mjs';
import { directionBrief } from './direction.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXCERPT_BYTES = 1800;

function parseArgs(argv) {
  const o = { dir: null, corpus: path.join(ROOT, 'corpus'), only: null, force: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slot') o.only = argv[++i];
    else if (a === '--all') o.all = true;
    else if (a === '--force') o.force = true;
    else if (a === '--corpus') o.corpus = path.resolve(argv[++i]);
    else if (a.startsWith('--')) { console.error(`Unknown argument: ${a}`); process.exit(2); }
    else o.dir = path.resolve(a);
  }
  return o;
}

/** A slice of the JS/CSS from a component that exhibits the technique — syntax to
 *  copy from, not markup to transplant. */
function excerptFor(corpus, technique) {
  for (const id of technique.seen_in || []) {
    const recPath = path.join(corpus, id, '.ingest.json');
    if (!fs.existsSync(recPath)) continue;
    const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
    const wanted = (rec.files || [])
      .filter((f) => isTextFile(f.path) && /\.(js|mjs|css)$/i.test(f.path))
      .sort((a, b) => b.size - a.size)[0];
    if (!wanted) continue;
    try { return fs.readFileSync(path.join(corpus, id, wanted.path), 'utf8').slice(0, EXCERPT_BYTES); }
    catch { /* try the next citation */ }
  }
  return '';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dir) { console.error('Usage: node scripts/rag/generate.mjs <composition-dir> [--slot key] [--force]'); process.exit(2); }
  const planFile = path.join(opts.dir, 'plan.json');
  if (!fs.existsSync(planFile)) { console.error(`No plan.json in ${opts.dir} — run compose.mjs first.`); process.exit(1); }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));

  // --all writes every slot, including the ones a component was found for. That
  // is the experiment: a page written entirely to one spec, against the same page
  // built by transplanting components, judged by the same critique.
  let targets = opts.all ? (plan.plan?.slots || []) : (plan.unfilled || []);
  if (opts.only) targets = targets.filter((u) => u.key === opts.only);
  if (!targets.length) { console.log('Nothing to write.'); return; }

  // Slots that were FILLED have no techniques attached — the composer only
  // retrieves them for slots it could not fill. Retrieve them here.
  const techniquesBySlot = { ...(plan.techniques || {}) };
  const needing = targets.filter((t) => !techniquesBySlot[t.key]);
  if (needing.length) {
    const cfg = embedConfig();
    const regFile = path.join(opts.corpus, 'techniques', 'index.json');
    const all = fs.existsSync(regFile)
      ? Object.values(JSON.parse(fs.readFileSync(regFile, 'utf8')).techniques || {})
        .filter((t) => Array.isArray(t.embedding) && t.embedding.length === cfg.dim)
      : [];
    if (all.length) {
      const vecs = await embedBatch(needing.map((t) => t.intent));
      needing.forEach((t, i) => { techniquesBySlot[t.key] = rankTechniques(all, vecs[i], {}, 3).map((r) => r.card); });
    }
  }

  // The art direction, if one was set. Without it every section is written in
  // isolation and the page comes out as a list of unrelated good intentions.
  const dirFile = path.join(opts.dir, 'direction.json');
  const direction = fs.existsSync(dirFile) ? JSON.parse(fs.readFileSync(dirFile, 'utf8')) : null;
  if (direction) console.log(`Direction: ${direction.idea}`);
  else console.log('No direction.json — sections will be written in isolation. Run direct.mjs first.');

  const outDir = path.join(opts.dir, 'generated');
  fs.mkdirSync(outDir, { recursive: true });
  const chat = await createChat(resolveLlm());
  const llm = resolveLlm();
  console.log(`Writing ${targets.length} section(s) with ${llm.provider}:${llm.model}`);

  let done = 0, failed = 0;
  for (const slot of targets) {
    const out = path.join(outDir, `${slot.key}.json`);
    if (!opts.force && fs.existsSync(out)) { console.log(`  ${slot.key.padEnd(12)} cached`); done++; continue; }
    const techniques = techniquesBySlot[slot.key] || [];
    const excerpts = {};
    for (const t of techniques) excerpts[t.id] = excerptFor(opts.corpus, t);
    try {
      const section = await generateSection(chat, {
        slot, tokens: plan.tokens || {}, techniques, excerpts,
        direction: direction ? directionBrief(direction, slot.key) : '',
        images: direction?.images || [],
        fontFamilies: direction ? [direction.type?.display?.family, direction.type?.body?.family].filter(Boolean) : [],
      });
      fs.writeFileSync(out, JSON.stringify({ slot: slot.key, ...section }, null, 2));
      done++;
      console.log(`  ${slot.key.padEnd(12)} ${section.html.length} B html, ${section.css.length} B css, ${section.js.length} B js · ${section.notes}`);
    } catch (e) {
      failed++;
      console.error(`  ${slot.key.padEnd(12)} FAILED: ${e.message}`);
    }
  }
  console.log(`\n${done} written, ${failed} failed. Next: node scripts/rag/assemble.mjs ${path.relative(ROOT, opts.dir)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exitCode = 1; });
}
