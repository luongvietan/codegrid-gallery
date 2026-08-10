#!/usr/bin/env node
// scripts/rag/compose.mjs — brief -> plan -> retrieve per slot -> normalize -> build brief.
//
// The step that turns two indexes into a page. It does NOT emit a finished site: it
// emits the decisions (which component per slot, which tokens win, what to rewrite,
// what to write fresh from techniques, what to merge after assembly) and leaves the
// code merge to the agent that reads BUILD.md. Everything it decides is auditable —
// including what it rejected and why.
//
//   VOYAGE_API_KEY=... ANTHROPIC_API_KEY=... node scripts/rag/compose.mjs "dark editorial studio site"
//   node scripts/rag/compose.mjs "..." --plan my-plan.json     # skip the LLM planner
//   LLM_PROVIDER=openai LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen3-coder \
//     EMBED_PROVIDER=ollama node scripts/rag/compose.mjs "..."  # free + local
//
// DB-free by design: it reads the cards and technique registry on disk, so a
// composition run needs no Supabase.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENUMS } from './schema.mjs';
import { resolveLlm, createChat, extractJson } from './llm.mjs';
import { embedBatch, embedConfig } from './provider.mjs';
import { rankLocal, rankTechniques } from './retrieval.mjs';
import { validatePlan, planSelection, normalizeTokens, buildBrief, inventoryOf, formatInventory } from './composition.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CANDIDATES_PER_SLOT = 8; // deep enough that the budget has a fallback to take

function parseArgs(argv) {
  const o = { corpus: path.join(ROOT, 'corpus'), terms: [], plan: null, out: null, filters: {}, minSim: 0.5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') o.plan = path.resolve(argv[++i]);
    else if (a === '--min-sim') o.minSim = Math.max(0, +argv[++i] || 0);
    else if (a === '--corpus') o.corpus = path.resolve(argv[++i]);
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--exclude-lib') o.filters.excludeAnimLibs = [...(o.filters.excludeAnimLibs || []), ...argv[++i].split(',')];
    else if (a === '--aesthetic') o.filters.aesthetic = argv[++i].split(',');
    else if (a === '--mood') o.filters.colorMood = argv[++i];
    else o.terms.push(a);
  }
  return o;
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'composition';

function planPrompt(brief, inventory) {
  return `You are planning the SKELETON of a website before any code is retrieved. Return ONLY one JSON object: {"title": "...", "slots": [{"key","scope","comp_type","intent"}, ...]}.

BRIEF: ${brief}

WHAT THE LIBRARY ACTUALLY HOLDS (type and how many). Plan against THIS, not against the full vocabulary — a slot of a type that is absent can never be filled:
${inventory}

RULES:
1. 5-9 slots, in the order they appear down the page. Globals (cursor, smooth_scroll, preloader, scroll_progress) and overlays (menu, modal, lightbox, page_transition) are their own slots, listed last.
2. "scope" is one of: ${ENUMS.scope.join(', ')}. "comp_type" MUST come from the inventory above. A cursor is scope "global", NOT a section.
3. "key": short lowercase identifier, unique ("hero", "work", "cursor").
4. "intent": one phrase in DESIGNER vocabulary describing what that slot should look and feel like — this string is the retrieval query, so write it the way you would describe the finished thing, not the code. Good: "dark full-bleed hero, headline reveals line by line on load". Bad: "hero using SplitText".
5. Only include what the brief actually needs. A page with fewer, sharper sections beats nine generic ones.`;
}

async function makePlan(chat, brief, inventory) {
  const messages = [{ role: 'user', content: planPrompt(brief, inventory) }];
  let lastErr = 'unknown';
  for (let i = 0; i < 3; i++) {
    const text = await chat(messages, 8000); // reasoning models bill thinking against this
    let plan;
    try { plan = extractJson(text); } catch (e) {
      lastErr = e.message;
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `That was not valid JSON (${e.message}). Return ONLY the JSON object.` });
      continue;
    }
    const { ok, errors } = validatePlan(plan);
    if (ok) return plan;
    lastErr = errors.join('; ');
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: `The plan failed validation. Fix ONLY these and return the full corrected JSON:\n- ${errors.join('\n- ')}` });
  }
  throw new Error(`plan validation failed after retries: ${lastErr}`);
}

function loadCards(corpus, dim) {
  const dir = path.join(corpus, 'cards');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((c) => Array.isArray(c.embedding) && c.embedding.length === dim);
}

function loadTechniques(corpus, dim) {
  const file = path.join(corpus, 'techniques', 'index.json');
  if (!fs.existsSync(file)) return [];
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.values(reg.techniques || {}).filter((t) => Array.isArray(t.embedding) && t.embedding.length === dim);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = opts.terms.join(' ').trim();
  if (!brief && !opts.plan) {
    console.error('Usage: node scripts/rag/compose.mjs "<brief>" [--plan file.json] [--aesthetic a,b] [--exclude-lib x] [--out dir]');
    process.exit(2);
  }

  const cfg = embedConfig();
  const cards = loadCards(opts.corpus, cfg.dim);
  if (!cards.length) { console.error('No embedded cards. Run: annotate.mjs -> embed.mjs'); process.exit(1); }
  const techniques = loadTechniques(opts.corpus, cfg.dim);

  let plan;
  if (opts.plan) {
    plan = JSON.parse(fs.readFileSync(opts.plan, 'utf8'));
    const { ok, errors } = validatePlan(plan);
    if (!ok) { console.error(`Plan is invalid:\n- ${errors.join('\n- ')}`); process.exit(1); }
  } else {
    const llm = resolveLlm();
    if (llm.provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
      console.error('Set ANTHROPIC_API_KEY, use LLM_PROVIDER=openai for a local endpoint, or pass --plan file.json');
      process.exit(1);
    }
    let chat;
    try { chat = await createChat(llm); } catch (e) { console.error(e.message); process.exit(1); }
    console.log(`Planning with ${llm.provider}:${llm.model}...`);
    plan = await makePlan(chat, brief, formatInventory(inventoryOf(cards)));
  }
  console.log(`Plan "${plan.title}": ${plan.slots.map((s) => s.key).join(' -> ')}`);

  // One embedding call for every slot intent: retrieval is query-space to
  // query-space (the intent reads like a probe, which is what the cards indexed).
  const vecs = await embedBatch(plan.slots.map((s) => s.intent));
  const candidatesBySlot = {};
  plan.slots.forEach((slot, i) => {
    candidatesBySlot[slot.key] = rankLocal(cards, vecs[i], {
      scope: slot.scope, compType: slot.comp_type, ...opts.filters,
    }, CANDIDATES_PER_SLOT);
  });

  // 0.5 is read off one real run (good picks 0.59-0.67, bad ones 0.45-0.49),
  // not derived from anything — --min-sim 0 restores the old fill-anything behaviour.
  const selection = planSelection(plan.slots, candidatesBySlot, undefined, opts.minSim);
  const tokenPlan = normalizeTokens(selection.picks);

  // Unfilled slots are where the technique index earns its keep: nothing fits, so
  // retrieve the mechanism and write fresh code rather than forcing a bad reuse.
  const techniquesBySlot = {};
  if (selection.unfilled.length && techniques.length) {
    const tvecs = await embedBatch(selection.unfilled.map((u) => u.intent));
    selection.unfilled.forEach((u, i) => {
      techniquesBySlot[u.key] = rankTechniques(techniques, tvecs[i], opts.filters, 3).map((r) => r.card);
    });
  }

  const outDir = opts.out || path.join(opts.corpus, 'compositions', slugify(plan.title));
  fs.mkdirSync(outDir, { recursive: true });
  const md = buildBrief(plan, selection, tokenPlan, techniquesBySlot);
  fs.writeFileSync(path.join(outDir, 'BUILD.md'), md);
  fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify({
    brief, plan, tokens: tokenPlan.tokens, anchor: tokenPlan.anchorId, rewrites: tokenPlan.rewrites,
    picks: selection.picks.map((p) => ({ slot: p.slot.key, id: p.card.id, sim: p.sim })),
    unfilled: selection.unfilled, rejected: selection.rejected,
    techniques: techniquesBySlot,
  }, null, 2));

  for (const p of selection.picks) console.log(`  ${p.slot.key.padEnd(12)} ${p.card.id}  sim=${p.sim.toFixed(3)}`);
  for (const u of selection.unfilled) console.log(`  ${u.key.padEnd(12)} (write fresh) — ${u.reason}`);
  console.log(`\nWrote ${path.relative(ROOT, outDir)}/BUILD.md — read it before merging any code.`);
}

main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
