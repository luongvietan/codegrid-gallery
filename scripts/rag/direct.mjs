#!/usr/bin/env node
// scripts/rag/direct.mjs — decide what the page is, before writing any of it.
//
// Reviewed by eye, the assembled pages were called lifeless, and the numbers
// agreed without saying so: the best verdict ever recorded was 3/5 and nothing
// ever shipped. Every step optimised for the absence of faults; none of them was
// a design decision. This one is.
//
// It also gathers the page's real images. The corpus holds 3370 of them and the
// generator had never been allowed to use one, so every written section drew
// placeholders — which is most of why the pages read as empty.
//
//   LLM_PROVIDER=openai LLM_MODEL=gpt-5.6-luna node scripts/rag/direct.mjs <composition-dir>
//
// Writes <dir>/direction.json and <dir>/page-assets/. generate.mjs reads both.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveLlm, createChat } from './llm.mjs';
import { directPage } from './direction.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_IMAGES = 14;

function parseArgs(argv) {
  const o = { dir: null, corpus: path.join(ROOT, 'corpus'), force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (a === '--corpus') o.corpus = path.resolve(argv[++i]);
    else if (a.startsWith('--')) { console.error(`Unknown argument: ${a}`); process.exit(2); }
    else o.dir = path.resolve(a);
  }
  return o;
}

/**
 * Real images for the page, taken from the components this composition already
 * touched — picked, rejected, or cited by a technique. They are topically related
 * to the brief because retrieval put them there, which is a better source than
 * any placeholder.
 */
function gatherImages(corpus, plan, outDir) {
  const ids = new Set([
    ...(plan.picks || []).map((p) => p.id),
    ...(plan.rejected || []).map((r) => r.id),
    ...Object.values(plan.techniques || {}).flat().flatMap((t) => t.seen_in || []),
  ].filter(Boolean));

  const chosen = [];
  for (const id of ids) {
    if (chosen.length >= MAX_IMAGES) break;
    const rec = path.join(corpus, id, '.ingest.json');
    if (!fs.existsSync(rec)) continue;
    const images = (JSON.parse(fs.readFileSync(rec, 'utf8')).images || [])
      .filter((i) => i.size > 20_000 && !/favicon|logo|icon/i.test(i.path))
      .sort((a, b) => b.size - a.size)
      .slice(0, 3);                                   // a few from each, not all of one
    for (const img of images) {
      if (chosen.length >= MAX_IMAGES) break;
      const name = `${chosen.length + 1}${path.extname(img.path).toLowerCase()}`;
      fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(path.join(corpus, id, img.path), path.join(outDir, name));
      chosen.push(`assets/page/${name}`);
    }
  }
  return chosen;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dir) { console.error('Usage: node scripts/rag/direct.mjs <composition-dir> [--force]'); process.exit(2); }
  const planFile = path.join(opts.dir, 'plan.json');
  if (!fs.existsSync(planFile)) { console.error(`No plan.json in ${opts.dir} — run compose.mjs first.`); process.exit(1); }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));

  const out = path.join(opts.dir, 'direction.json');
  if (!opts.force && fs.existsSync(out)) { console.log('Direction already set (--force to redo).'); return; }

  const images = gatherImages(opts.corpus, plan, path.join(opts.dir, 'page-assets'));
  console.log(`${images.length} real image(s) gathered for the page`);

  const llm = resolveLlm();
  const chat = await createChat(llm);
  const slots = plan.plan?.slots || [];
  console.log(`Directing "${plan.plan?.title}" with ${llm.provider}:${llm.model}...`);

  const direction = await directPage(chat, plan.brief || plan.plan?.title || '', slots, plan.tokens || {});
  fs.writeFileSync(out, JSON.stringify({ ...direction, images }, null, 2));

  console.log(`\n  idea      ${direction.idea}`);
  console.log(`  palette   bg ${direction.palette.bg} · fg ${direction.palette.fg} · accent ${direction.palette.accent} (${direction.palette.accent_rule})`);
  console.log(`  type      ${direction.type.display.family} / ${direction.type.body.family} at ${direction.type.scale_ratio}`);
  console.log(`  motion    ${direction.motion_signature}`);
  console.log(`  signature ${direction.signature_moment.slot}: ${direction.signature_moment.what}`);
  console.log(`  rhythm    ${direction.rhythm.map((r) => `${r.slot}:${r.density}/${r.height}`).join('  ')}`);
  console.log(`\nWrote ${path.relative(ROOT, out)}. Next: node scripts/rag/generate.mjs ${path.relative(ROOT, opts.dir)} --all --force`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exitCode = 1; });
}
