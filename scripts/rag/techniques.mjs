// scripts/rag/techniques.mjs
// Technique extraction — the second annotation pass, and the second index.
//
// The component index answers "assemble a whole site": retrieve a section, adapt it.
// Retrieve only components and you get collage. This pass mines the *techniques* out
// of those components — a mechanism you could apply to different content — so the
// composer can retrieve a technique, write FRESH code, and cite 2-3 components for
// exact syntax (`seen_in`). That is where novelty comes from.
//
// Everything here is pure (the LLM arrives as an injected `chat` function), so the
// whole pass is unit-tested offline with a fake chat — no key, no network.
import { ENUMS } from './schema.mjs';
import { extractJson } from './llm.mjs';

// What the extractor LLM must return per technique (the registry adds id/seen_in/sources).
export const TECHNIQUE_LLM_FIELDS = [
  'name', 'mechanism', 'animation_libs', 'params', 'variations', 'description', 'retrieval_probes',
];

const MAX_PROBES = 5;
const MAX_VARIATIONS = 8;
const MAX_STRING_VALUES = 8;
const MAX_PER_CARD = 4;
const MAX_CODE = 24000;

/** `Staggered char reveal` -> `tech_staggered_char_reveal`. The merge key: two
 *  cards naming the same technique differently must collapse to one row. */
export function slugifyTechniqueId(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
    .replace(/_+$/, '');
  return `tech_${slug}`;
}

function isParamScalar(v) { return typeof v === 'number' && Number.isFinite(v); }

/** Validate one raw technique. Same contract as validateCard: human-readable
 *  errors, fed straight back to the model on retry. */
export function validateTechnique(t) {
  const errors = [];
  if (t == null || typeof t !== 'object' || Array.isArray(t)) {
    return { ok: false, errors: ['technique is not an object'] };
  }
  for (const f of ['name', 'mechanism', 'description']) {
    if (typeof t[f] !== 'string' || !t[f].trim()) errors.push(`${f}: must be a non-empty string`);
  }
  const libs = new Set(ENUMS.anim_lib);
  if (!Array.isArray(t.animation_libs)) errors.push('animation_libs: must be an array');
  else for (const l of t.animation_libs) if (!libs.has(l)) errors.push(`animation_libs: "${l}" not in enum anim_lib`);

  if (!Array.isArray(t.variations) || t.variations.some((v) => typeof v !== 'string')) {
    errors.push('variations: must be a string array');
  }
  const probes = Array.isArray(t.retrieval_probes)
    ? t.retrieval_probes.filter((p) => typeof p === 'string' && p.trim()).length : -1;
  if (probes < 3 || probes > MAX_PROBES) {
    errors.push(`retrieval_probes: expected 3-${MAX_PROBES} non-empty probes, got ${Math.max(probes, 0)}`);
  }

  if (t.params == null || typeof t.params !== 'object' || Array.isArray(t.params)) {
    errors.push('params: must be an object');
  } else {
    for (const [k, v] of Object.entries(t.params)) {
      const okScalar = isParamScalar(v) || typeof v === 'string';
      const okArray = Array.isArray(v) && v.length > 0
        && v.every((x) => isParamScalar(x) || typeof x === 'string');
      if (!okScalar && !okArray) errors.push(`params.${k}: must be a number, a string, or an array of those`);
    }
  }
  return { ok: errors.length === 0, errors };
}

const uniq = (xs) => [...new Set(xs)];
const isNumRange = (v) => Array.isArray(v) && v.length === 2 && v.every(isParamScalar);

/** Canonical param form: numbers -> [min, max] range, strings -> unique string list.
 *  A range is what the composer actually needs ("stagger lives between 0.02 and 0.05"). */
export function normalizeParams(params = {}) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (isParamScalar(v)) { out[k] = [v, v]; continue; }
    if (typeof v === 'string') { out[k] = [v]; continue; }
    if (Array.isArray(v) && v.length && v.every(isParamScalar)) { out[k] = [Math.min(...v), Math.max(...v)]; continue; }
    if (Array.isArray(v)) out[k] = uniq(v.map(String)).slice(0, MAX_STRING_VALUES);
  }
  return out;
}

/** Merge two normalized param values: widen ranges, union string lists. Mixed
 *  kinds degrade to a string list rather than dropping one side. */
export function mergeParamValue(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (isNumRange(a) && isNumRange(b)) return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
  const flat = [...a, ...b].map(String);
  return uniq(flat).slice(0, MAX_STRING_VALUES);
}

// Both sides get normalized: the stored row always is, but a caller merging two
// raw extractions should not have to know that.
function mergeParams(a = {}, b = {}) {
  const out = normalizeParams(a);
  for (const [k, v] of Object.entries(normalizeParams(b))) out[k] = mergeParamValue(out[k], v);
  return out;
}

/**
 * Fold an incoming technique (from `componentId`) into the stored one.
 * Prose (name/mechanism/description) is FIRST-WRITER-WINS on purpose: it is what
 * gets embedded, so letting a later card rewrite it would invalidate the stored
 * vector on every re-run. Evidence (libs, params, variations, probes, seen_in)
 * accumulates — that is the part that gets better with more sources.
 */
export function mergeTechnique(existing, incoming, componentId) {
  const seen = existing.seen_in || [];
  const isNew = componentId && !seen.includes(componentId);
  return {
    ...existing,
    animation_libs: uniq([...(existing.animation_libs || []), ...(incoming.animation_libs || [])]),
    params: mergeParams(existing.params, incoming.params),
    variations: uniq([...(existing.variations || []), ...(incoming.variations || [])]).slice(0, MAX_VARIATIONS),
    retrieval_probes: uniq([...(existing.retrieval_probes || []), ...(incoming.retrieval_probes || [])]).slice(0, MAX_PROBES),
    seen_in: isNew ? [...seen, componentId] : seen,
    sources: isNew ? (existing.sources || seen.length) + 1 : (existing.sources || seen.length),
  };
}

/** What we embed for the technique index. Mechanism is included (unlike the
 *  component card) because "how it's built" IS the retrieval target here. */
export function techniqueEmbeddingText(t) {
  const probes = Array.isArray(t.retrieval_probes) ? t.retrieval_probes.join('\n') : '';
  return `${t.description || ''}\n${t.mechanism || ''}\n${probes}`.trim();
}

export function buildTechniquePrompt(card, knownNames = []) {
  const known = knownNames.length
    ? `\nEXISTING TECHNIQUE NAMES — if one of these is the same technique, reuse the name VERBATIM (that is how duplicates merge instead of multiplying):\n${knownNames.map((n) => `- ${n}`).join('\n')}\n`
    : '';
  return `You are mining REUSABLE TECHNIQUES out of one front-end component so an AI can later write fresh code with them. Return ONLY one JSON object (no markdown fence, no prose): {"techniques": [ ... ]} with 1-${MAX_PER_CARD} entries, each having EXACTLY these keys: ${TECHNIQUE_LLM_FIELDS.join(', ')}.

A technique is a MECHANISM that transfers to different content ("staggered char reveal", "pinned section with scrubbed timeline", "magnetic button"). It is NOT this component ("the hero"), NOT a library ("gsap"), and NOT a styling choice ("dark background").
${known}
RULES:
1. "name": 2-4 words, lowercase-able, content-neutral. Reuse an existing name above when it is the same technique.
2. "mechanism": one line, the pipeline in code terms — e.g. "SplitText -> chars -> gsap.from + ScrollTrigger scrub".
3. "animation_libs": array from this enum ONLY (["none"] if plain CSS/JS): ${ENUMS.anim_lib.join(', ')}.
4. "params": the real numbers from THIS code — {stagger: [0.02, 0.05], y: 40, ease: "power3.out"}. Numbers or 2-value [min,max] ranges or strings. Never nested objects. Omit what the code does not show.
5. "variations": 1-4 short phrases for how it could be varied ("reveal by word instead of char").
6. "description" (40-80 words): the EFFECT AS SEEN, for someone who cannot see the screen. No class names, no file names, no brand names, no marketing words.
7. "retrieval_probes": 3-${MAX_PROBES} short phrases a DESIGNER would type to find this. Brief vocabulary, not code vocabulary. Good: "letters slide up as you scroll". Bad: "gsap.from with stagger".
8. Skip anything trivial (a plain hover color change). Fewer, sharper techniques beat four vague ones.

COMPONENT (${card.comp_type ?? 'unknown'} / ${card.id}) — what it looks like:
${card.description ?? ''}

SOURCE:
${String(card.code ?? '').slice(0, MAX_CODE)}`;
}

/**
 * Ask the model for this card's techniques, validating every entry client-side
 * with the same retry-with-errors loop the annotator uses (principle: enums are
 * enforced by code, not by prompt-begging). Returns id-stamped techniques.
 */
export async function extractTechniques(chat, card, knownNames = [], attempts = 3) {
  const messages = [{ role: 'user', content: buildTechniquePrompt(card, knownNames) }];
  let lastErr = 'unknown';
  for (let i = 0; i < attempts; i++) {
    const text = await chat(messages, 16000); // reasoning models bill thinking against this
    let list;
    try {
      const obj = extractJson(text);
      list = Array.isArray(obj.techniques) ? obj.techniques : null;
      if (!list) throw new Error('missing "techniques" array');
      if (!list.length) throw new Error('"techniques" is empty');
    } catch (e) {
      lastErr = e.message;
      messages.push({ role: 'assistant', content: text },
        { role: 'user', content: `That was not usable (${e.message}). Return ONLY {"techniques":[...]}.` });
      continue;
    }
    const errors = [];
    list.slice(0, MAX_PER_CARD).forEach((t, idx) => {
      const r = validateTechnique(t);
      if (!r.ok) errors.push(...r.errors.map((e) => `techniques[${idx}].${e}`));
    });
    if (!errors.length) {
      return list.slice(0, MAX_PER_CARD).map((t) => ({
        ...t,
        id: slugifyTechniqueId(t.name),
        params: normalizeParams(t.params),
        variations: uniq(t.variations).slice(0, MAX_VARIATIONS),
        retrieval_probes: uniq(t.retrieval_probes.filter((p) => p.trim())).slice(0, MAX_PROBES),
      }));
    }
    lastErr = errors.join('; ');
    messages.push({ role: 'assistant', content: text },
      { role: 'user', content: `Some entries failed validation. Fix ONLY these and return the full corrected JSON:\n- ${errors.join('\n- ')}` });
  }
  throw new Error(`technique validation failed after retries: ${lastErr}`);
}

// ---------- Registry (the on-disk technique index, before it reaches Postgres) ----------

export function emptyRegistry() {
  return { schema_version: 1, techniques: {}, sources: {} };
}

/** Fold one card's techniques into the registry, recording the component link. */
export function addToRegistry(registry, componentId, techniques) {
  const ids = [];
  for (const t of techniques) {
    const id = t.id || slugifyTechniqueId(t.name);
    const existing = registry.techniques[id];
    registry.techniques[id] = existing
      ? mergeTechnique(existing, t, componentId)
      : {
        id,
        name: t.name,
        mechanism: t.mechanism,
        description: t.description,
        animation_libs: uniq(t.animation_libs || []),
        params: normalizeParams(t.params),
        variations: uniq(t.variations || []).slice(0, MAX_VARIATIONS),
        retrieval_probes: uniq(t.retrieval_probes || []).slice(0, MAX_PROBES),
        seen_in: [componentId],
        sources: 1,
        schema_version: 1,
      };
    if (!ids.includes(id)) ids.push(id);
  }
  registry.sources[componentId] = ids;
  return registry;
}

/** Flatten to component_techniques rows, in card order then technique order. */
export function registryLinks(registry) {
  const rows = [];
  for (const [componentId, ids] of Object.entries(registry.sources || {})) {
    for (const technique_id of ids) rows.push({ component_id: componentId, technique_id });
  }
  return rows;
}

/** The vocabulary handed to the next extraction call so ids converge. */
export function knownNamesOf(registry) {
  return Object.values(registry.techniques || {}).map((t) => t.name);
}
