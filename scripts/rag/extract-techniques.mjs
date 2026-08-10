#!/usr/bin/env node
// scripts/rag/extract-techniques.mjs — the second annotation pass: mine the
// `techniques` index out of the component cards.
//
// Components answer "assemble a site". Techniques answer "invent one": retrieve a
// mechanism, write fresh code, cite `seen_in` for exact syntax. Reads
// corpus/cards/*.json (annotate.mjs output) and grows corpus/techniques/index.json.
//
//   ANTHROPIC_API_KEY=... node scripts/rag/extract-techniques.mjs --limit 20
//   LLM_PROVIDER=openai LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen3-coder \
//     node scripts/rag/extract-techniques.mjs          # free + local
//
// Deliberately SEQUENTIAL: each call is handed the vocabulary mined so far so the
// model reuses existing names. Run it concurrently and the same technique gets four
// names in four workers — the index multiplies instead of converging.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLlm, createChat } from './llm.mjs';
import { extractTechniques, emptyRegistry, addToRegistry, knownNamesOf } from './techniques.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_KNOWN_NAMES = 60; // keep the prompt bounded once the vocabulary is large

function parseArgs(argv) {
  const o = { corpus: path.join(ROOT, 'corpus'), limit: 0, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (a === '--limit') o.limit = Math.max(0, +argv[++i] || 0);
    else if (a === '--corpus') o.corpus = path.resolve(argv[++i]);
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return o;
}

function loadRegistry(file, force) {
  if (force || !fs.existsSync(file)) return emptyRegistry();
  try { return { ...emptyRegistry(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch { return emptyRegistry(); }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cardsDir = path.join(opts.corpus, 'cards');
  if (!fs.existsSync(cardsDir)) {
    console.error('No cards. Run: node scripts/rag/annotate.mjs');
    process.exit(1);
  }
  const llm = resolveLlm();
  if (llm.provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY, or use a free/local endpoint:\n  LLM_PROVIDER=openai LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen3-coder node scripts/rag/extract-techniques.mjs');
    process.exit(1);
  }
  let chat;
  try { chat = await createChat(llm); } catch (e) { console.error(e.message); process.exit(1); }

  const outDir = path.join(opts.corpus, 'techniques');
  const outFile = path.join(outDir, 'index.json');
  fs.mkdirSync(outDir, { recursive: true });
  const registry = loadRegistry(outFile, opts.force);

  let files = fs.readdirSync(cardsDir).filter((f) => f.endsWith('.json')).sort();
  if (!opts.force) files = files.filter((f) => !registry.sources[path.basename(f, '.json')]);
  if (opts.limit) files = files.slice(0, opts.limit);

  console.log(`Extracting techniques from ${files.length} card(s) with ${llm.provider}:${llm.model}${llm.baseUrl ? ` @ ${llm.baseUrl}` : ''}`);
  if (!files.length) { console.log('Nothing to do (all cards already mined — use --force to redo).'); return; }

  let n = 0, failed = 0;
  for (const f of files) {
    const card = JSON.parse(fs.readFileSync(path.join(cardsDir, f), 'utf8'));
    n++;
    try {
      const known = knownNamesOf(registry).slice(0, MAX_KNOWN_NAMES);
      const techniques = await extractTechniques(chat, card, known);
      addToRegistry(registry, card.id, techniques);
      fs.writeFileSync(outFile, JSON.stringify(registry, null, 2)); // checkpoint every card: resumable
      console.log(`[${n}/${files.length}] ${card.id} · ${techniques.map((t) => t.id.replace(/^tech_/, '')).join(', ')}`);
    } catch (e) {
      failed++;
      console.error(`[${n}/${files.length}] ${card.id} · FAILED: ${e.message}`);
    }
  }

  const total = Object.keys(registry.techniques).length;
  const reused = Object.values(registry.techniques).filter((t) => (t.sources || 1) > 1).length;
  console.log(`\n${total} technique(s), ${reused} seen in more than one component${failed ? `, ${failed} card(s) failed` : ''}.`);
  console.log(`Wrote ${path.relative(ROOT, outFile)}. Next: node scripts/rag/embed.mjs --techniques`);
}

main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
