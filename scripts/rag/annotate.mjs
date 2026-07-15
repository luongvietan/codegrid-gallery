#!/usr/bin/env node
// scripts/rag/annotate.mjs — turn each ingested project into a Card (annotation layer).
//
// Reads corpus/<id>/ source, asks Claude to describe the OUTPUT (not the code) and
// classify it against the controlled vocabulary, validates every enum client-side
// (validateCard) with a retry loop, and writes corpus/cards/<id>.json. Idempotent.
//
//   npm i @anthropic-ai/sdk
//   ANTHROPIC_API_KEY=... node scripts/rag/annotate.mjs --limit 20
//
// Needs the corpus (run scripts/ingest.mjs first) and an API key — so it runs
// where R2 is reachable, not inside an egress-restricted sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTextFile } from '../ingest-lib.mjs';
import { ENUMS, LLM_FIELDS, validateCard } from './schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL = 'claude-opus-4-8';
const MAX_SOURCE = 45000;
const FRAMEWORK_HINT = { html: 'vanilla', react: 'react', nextjs: 'next' };

function parseArgs(argv) {
  const o = { corpus: path.join(ROOT, 'corpus'), limit: 0, concurrency: 3, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (a === '--corpus') o.corpus = path.resolve(argv[++i]);
    else if (a === '--limit') o.limit = Math.max(0, +argv[++i] || 0);
    else if (a === '--concurrency') o.concurrency = Math.max(1, +argv[++i] || 3);
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return o;
}

function gatherSource(dir, record) {
  const files = (record.files || []).map((f) => f.path);
  const entry = record.entryHtml && files.includes(record.entryHtml) ? record.entryHtml : null;
  const ordered = [entry, ...files.filter((p) => p !== entry)].filter(Boolean);
  let used = 0, loc = 0;
  const parts = [];
  for (const rel of ordered) {
    if (!isTextFile(rel)) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { continue; }
    loc += text.split('\n').length;
    if (used >= MAX_SOURCE) continue;
    const slice = text.slice(0, Math.max(0, MAX_SOURCE - used));
    parts.push(`\n===== ${rel} =====\n${slice}`);
    used += slice.length;
  }
  return { source: parts.join('\n'), loc };
}

function enumList(key) { return ENUMS[key].join(', '); }

function buildPrompt(record, source, frameworkHint) {
  return `You are indexing a front-end component rebuilt from an awwwards-style site so an AI can later find and reassemble it. Read ALL the code, then return ONLY one JSON object (no markdown fence, no prose) with EXACTLY these keys: ${LLM_FIELDS.join(', ')}.

Framework hint (from the archive): ${frameworkHint}. Title: ${record.title ?? record.id}. Entry: ${record.entryHtml ?? '(none)'}.

RULES:
1. Every enum field MUST use a value from its list below — never invent one. If nothing fits, pick the closest and explain in "notes".
   scope: ${enumList('scope')}
   comp_type: ${enumList('comp_type')}   (cursor/smooth_scroll/preloader/scroll_progress/audio_toggle are scope=global; menu/modal/lightbox/page_transition are scope=overlay; the rest are scope=section)
   framework: ${enumList('framework')}
   animation_libs (array, [] if none): ${enumList('anim_lib')}
   css_approach: ${enumList('css_approach')}
   asset_types (array): ${enumList('asset_type')}
   side_effects (array): ${enumList('side_effect')}
   aesthetic (array, 1-3): ${enumList('aesthetic')}
   motion_character (array): ${enumList('motion_tag')}
   density: ${enumList('density')}
   color_mood: ${enumList('color_mood')}
   responsive: ${enumList('responsive')}
   coupling: ${enumList('coupling')}
2. "description" (80-140 words), three seamless parts: (a) WHAT YOU SEE — layout, proportions, relative type size, color, density, for someone who can't see the screen; (b) WHAT HAPPENS — what moves, triggered by what, how it feels; (c) MECHANISM — one sentence on how it's built. FORBIDDEN: class/variable/file/brand names; marketing words ("beautiful", "modern", "stunning").
3. "retrieval_probes": 3-5 short phrases a DESIGNER might type to find this (brief vocabulary, NOT code vocabulary). Good: "dark editorial hero, text reveals on scroll". Bad: "component using SplitText and ScrollTrigger".
4. "side_effects": read carefully — does it touch document.body.style? run its own requestAnimationFrame? add listeners to window? Missing this field is the worst error.
5. "design_tokens": {fonts:[{family,role,weights:[]}], type_scale_px:[], colors:{bg,fg,accent}, spacing_unit_px, radius_px, max_width_px, grid_columns} — fill what the code shows, null otherwise.
6. "content_slots": {text:[{key,max_chars,note}], media:[{key,type,aspect,required}], repeatable:{key,min,max}|null} — max_chars estimated from the real layout (if the headline is designed for 3 words, say so).
7. Unsure -> null. Never fabricate. "needs_webgl" is a boolean.

SOURCE:
${source}`;
}

function extractJson(text) {
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('no JSON object in response');
  return JSON.parse(t.slice(s, e + 1));
}

async function annotateOne(client, record, source, frameworkHint) {
  let messages = [{ role: 'user', content: buildPrompt(record, source, frameworkHint) }];
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await client.messages.create({ model: MODEL, max_tokens: 3000, messages });
    const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let card;
    try { card = extractJson(text); } catch (e) { lastErr = e.message; messages.push({ role: 'assistant', content: text }, { role: 'user', content: `That was not valid JSON (${e.message}). Return ONLY the JSON object.` }); continue; }
    const { ok, errors } = validateCard(card);
    if (ok) return card;
    lastErr = errors.join('; ');
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: `The JSON failed validation. Fix ONLY these and return the full corrected JSON:\n- ${errors.join('\n- ')}` });
  }
  throw new Error(`validation failed after retries: ${lastErr}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY first.'); process.exit(1); }
  const manifestPath = path.join(opts.corpus, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { console.error(`No corpus manifest. Run: node scripts/ingest.mjs`); process.exit(1); }
  let Anthropic;
  try { ({ default: Anthropic } = await import('@anthropic-ai/sdk')); }
  catch { console.error('Run: npm i @anthropic-ai/sdk'); process.exit(1); }
  const client = new Anthropic();

  const cardsDir = path.join(opts.corpus, 'cards');
  fs.mkdirSync(cardsDir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let projects = manifest.projects.filter((p) => p.status === 'ok');
  if (opts.limit) projects = projects.slice(0, opts.limit);

  let done = 0;
  const queue = [...projects];
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      const out = path.join(cardsDir, `${p.id}.json`);
      if (!opts.force && fs.existsSync(out)) { console.log(`[${++done}/${projects.length}] ${p.id} · cached`); continue; }
      const dir = path.join(opts.corpus, p.id);
      const record = JSON.parse(fs.readFileSync(path.join(dir, '.ingest.json'), 'utf8'));
      const { source, loc } = gatherSource(dir, record);
      if (!source.trim()) { console.log(`[${++done}/${projects.length}] ${p.id} · no source`); continue; }
      try {
        const card = await annotateOne(client, record, source, FRAMEWORK_HINT[p.type] || 'vanilla');
        const full = { id: p.id, source_path: record.folder, origin_site: null, loc,
          schema_version: 1, annotator_model: MODEL, ...card, code: source.slice(0, 60000) };
        fs.writeFileSync(out, JSON.stringify(full, null, 2));
        console.log(`[${++done}/${projects.length}] ${p.id} · ${card.scope}/${card.comp_type} ✓`);
      } catch (e) {
        console.error(`[${++done}/${projects.length}] ${p.id} · FAILED: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, projects.length) }, worker));
  console.log(`\nCards in ${path.relative(ROOT, cardsDir)}/. Next: node scripts/rag/embed.mjs`);
}

main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
