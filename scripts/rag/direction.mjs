// scripts/rag/direction.mjs
// The missing step: decide what the page IS before writing any of it.
//
// Everything upstream optimises for the absence of faults. The composer picks by
// similarity, the budget blocks technical conflicts, the critique counts
// blockers. None of them is a design decision, and a page can pass all three and
// still be seven independent sections that happen to share a palette. Reviewed by
// eye, that is exactly what came out: not broken so much as lifeless.
//
// An art direction is one idea, stated before the sections exist, that every
// section then has to obey — a type pairing, a colour with a rule about how
// rarely it appears, a rhythm of dense and sparse, one motion signature, and one
// moment the page is built around. Sections stop being independent because they
// are no longer allowed to be.
//
// Pure — the LLM arrives as an injected `chat`, unit-tested offline.
import { extractJson } from './llm.mjs';

export const DENSITY = ['sparse', 'balanced', 'dense'];
export const HEIGHT = ['full', 'tall', 'auto'];

export const DIRECTION_FIELDS = [
  'idea', 'palette', 'type', 'motion_signature', 'signature_moment', 'rhythm', 'rules',
];

export function buildDirectionPrompt(brief, slots, tokens = {}) {
  const slotList = slots.map((s) => `${s.key} (${s.comp_type}) — ${s.intent}`).join('\n');
  const seed = tokens.colors?.bg ? `\nThe components already chosen suggest: background ${tokens.colors.bg}, foreground ${tokens.colors.fg}, accent ${tokens.colors.accent}. Use them if they serve the idea; overrule them if they do not.` : '';
  return `You are the art director. Before a single section is written, decide what this page IS. Return ONLY one JSON object with keys: ${DIRECTION_FIELDS.join(', ')}.

BRIEF: ${brief}

SECTIONS, in page order:
${slotList}${seed}

RULES:
1. "idea": ONE sentence naming the through-line — the thing a visitor would describe afterwards. Not "modern and clean". Something with a point of view: "the work is the only thing in colour", "the page reads like a contact sheet, one frame at a time".
2. "palette": {bg, fg, accent, muted} as hex, plus "accent_rule": exactly when the accent is allowed to appear. A colour used everywhere is not an accent.
3. "type": {display: {family, weight, case, tracking}, body: {family, weight}, scale_ratio, max_measure_ch}. Pick real, widely available families (a Google font for display is fine; a system stack for body is fine). scale_ratio between 1.2 and 2.0 — one ratio, applied throughout. The display face must CONTRAST with the body face: a different family, or at minimum a weight or case the body never uses. One family at one weight for both is the flattest page there is.
4. "motion_signature": ONE mechanism every section shares (e.g. "everything enters by a mask wipe from the left, 0.6s, power3.out"). Not a list. Repetition is what makes motion read as intent rather than decoration.
5. "signature_moment": {slot, what} — the one thing this page is built around, and which section carries it. Everything else supports it and must be quieter.
6. "rhythm": one entry per section above, in order: {slot, density (${DENSITY.join('|')}), height (${HEIGHT.join('|')}), role}. Vary it. Three full-height dense sections in a row is why assembled pages feel like a list.
7. "rules": 3-5 imperatives a section author must obey, specific enough to break ("body text never centred", "one accent element per screen", "images always bleed off one edge").
8. No brand names, no marketing adjectives. Decisions, not vibes.`;
}

const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim());

export function validateDirection(d, slotKeys = []) {
  const errors = [];
  if (d == null || typeof d !== 'object' || Array.isArray(d)) return { ok: false, errors: ['direction is not an object'] };

  if (typeof d.idea !== 'string' || d.idea.trim().split(/\s+/).length < 5) errors.push('idea: one real sentence, not a phrase');
  if (/\b(modern|clean|sleek|stunning|beautiful|elegant)\b/i.test(String(d.idea))) {
    errors.push('idea: "modern/clean/sleek" is not a point of view — say what a visitor would describe afterwards');
  }

  const p = d.palette;
  if (!p || typeof p !== 'object') errors.push('palette: required');
  else {
    for (const k of ['bg', 'fg', 'accent']) if (!isHex(p[k])) errors.push(`palette.${k}: must be a hex colour`);
    if (typeof p.accent_rule !== 'string' || !p.accent_rule.trim()) errors.push('palette.accent_rule: say exactly when the accent may appear');
  }

  const t = d.type;
  if (!t || typeof t !== 'object') errors.push('type: required');
  else {
    if (!t.display?.family) errors.push('type.display.family: required');
    if (!t.body?.family) errors.push('type.body.family: required');
    const r = Number(t.scale_ratio);
    if (!(r >= 1.2 && r <= 2.0)) errors.push('type.scale_ratio: one number between 1.2 and 2.0');
    // One family set at one weight for both roles is the flattest possible
    // typography, and it is what "lifeless" looks like in a direction file.
    const same = String(t.display?.family || '').trim().toLowerCase() === String(t.body?.family || '').trim().toLowerCase();
    const contrast = t.display?.weight && t.body?.weight && String(t.display.weight) !== String(t.body.weight);
    const cased = t.display?.case && /upper|small-caps/i.test(String(t.display.case));
    if (same && !contrast && !cased) {
      errors.push('type: display and body are the same face with no contrast — pair two families, or give the display face a weight or case the body does not have');
    }
  }

  if (typeof d.motion_signature !== 'string' || !d.motion_signature.trim()) errors.push('motion_signature: one mechanism, as a sentence');
  if (Array.isArray(d.motion_signature)) errors.push('motion_signature: one mechanism, not a list');

  const sm = d.signature_moment;
  if (!sm || !sm.slot || !sm.what) errors.push('signature_moment: {slot, what} required');
  else if (slotKeys.length && !slotKeys.includes(sm.slot)) errors.push(`signature_moment.slot: "${sm.slot}" is not one of ${slotKeys.join(', ')}`);

  if (!Array.isArray(d.rhythm)) errors.push('rhythm: must be an array, one entry per section');
  else {
    const seen = d.rhythm.map((r) => r?.slot);
    for (const k of slotKeys) if (!seen.includes(k)) errors.push(`rhythm: missing an entry for "${k}"`);
    d.rhythm.forEach((r, i) => {
      if (!DENSITY.includes(r?.density)) errors.push(`rhythm[${i}].density: one of ${DENSITY.join(', ')}`);
      if (!HEIGHT.includes(r?.height)) errors.push(`rhythm[${i}].height: one of ${HEIGHT.join(', ')}`);
      if (typeof r?.role !== 'string' || !r.role.trim()) errors.push(`rhythm[${i}].role: what this section does for the page`);
    });
    // A page whose every section is full-height dense is the list we are trying
    // to stop producing.
    const full = d.rhythm.filter((r) => r?.height === 'full').length;
    if (slotKeys.length >= 4 && full === d.rhythm.length) errors.push('rhythm: every section full-height is a list, not a rhythm — vary it');
  }

  const rules = d.rules;
  if (!Array.isArray(rules) || rules.length < 3 || rules.length > 5 || rules.some((r) => typeof r !== 'string' || !r.trim())) {
    errors.push('rules: 3-5 specific imperatives');
  }
  return { ok: errors.length === 0, errors };
}

/** The direction, rendered for a section author: what the page is, and what this
 *  section owes it. */
export function directionBrief(direction, slotKey) {
  const r = (direction.rhythm || []).find((x) => x.slot === slotKey) || {};
  const isSignature = direction.signature_moment?.slot === slotKey;
  const p = direction.palette || {};
  const t = direction.type || {};
  return [
    `THE PAGE'S IDEA: ${direction.idea}`,
    `PALETTE: bg ${p.bg}, fg ${p.fg}, accent ${p.accent}${p.muted ? `, muted ${p.muted}` : ''}. Accent rule: ${p.accent_rule}`,
    `TYPE: display ${t.display?.family} ${t.display?.weight ?? ''} ${t.display?.case ?? ''}; body ${t.body?.family}; scale ratio ${t.scale_ratio}${t.max_measure_ch ? `; body measure max ${t.max_measure_ch}ch` : ''}`,
    `MOTION SIGNATURE (this section must use it, not invent another): ${direction.motion_signature}`,
    `THIS SECTION: density ${r.density ?? 'balanced'}, height ${r.height ?? 'auto'} — ${r.role ?? 'supporting'}`,
    isSignature
      ? `THIS SECTION CARRIES THE SIGNATURE MOMENT: ${direction.signature_moment.what}. It is the loudest thing on the page.`
      : `The signature moment belongs to "${direction.signature_moment?.slot}" — stay quieter than it.`,
    `RULES: ${(direction.rules || []).map((x, i) => `${i + 1}) ${x}`).join(' ')}`,
  ].join('\n');
}

export async function directPage(chat, brief, slots, tokens = {}, attempts = 3) {
  const slotKeys = slots.map((s) => s.key);
  const messages = [{ role: 'user', content: buildDirectionPrompt(brief, slots, tokens) }];
  let lastErr = 'unknown';
  for (let i = 0; i < attempts; i++) {
    const text = await chat(messages, 8000);
    let d;
    try { d = extractJson(text); } catch (e) {
      lastErr = e.message;
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Not valid JSON (${e.message}). Return ONLY the JSON object.` });
      continue;
    }
    const { ok, errors } = validateDirection(d, slotKeys);
    if (ok) return d;
    lastErr = errors.join('; ');
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Fix ONLY these and return the full corrected JSON:\n- ${errors.join('\n- ')}` });
  }
  throw new Error(`art direction failed after retries: ${lastErr}`);
}
