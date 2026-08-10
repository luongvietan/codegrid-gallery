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
import { generateSection } from './generation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXCERPT_BYTES = 1800;

function parseArgs(argv) {
  const o = { dir: null, corpus: path.join(ROOT, 'corpus'), only: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slot') o.only = argv[++i];
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

  let unfilled = plan.unfilled || [];
  if (opts.only) unfilled = unfilled.filter((u) => u.key === opts.only);
  if (!unfilled.length) { console.log('No unfilled slots to write.'); return; }

  const outDir = path.join(opts.dir, 'generated');
  fs.mkdirSync(outDir, { recursive: true });
  const chat = await createChat(resolveLlm());
  const llm = resolveLlm();
  console.log(`Writing ${unfilled.length} section(s) with ${llm.provider}:${llm.model}`);

  let done = 0, failed = 0;
  for (const slot of unfilled) {
    const out = path.join(outDir, `${slot.key}.json`);
    if (!opts.force && fs.existsSync(out)) { console.log(`  ${slot.key.padEnd(12)} cached`); done++; continue; }
    const techniques = (plan.techniques || {})[slot.key] || [];
    const excerpts = {};
    for (const t of techniques) excerpts[t.id] = excerptFor(opts.corpus, t);
    try {
      const section = await generateSection(chat, { slot, tokens: plan.tokens || {}, techniques, excerpts });
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
