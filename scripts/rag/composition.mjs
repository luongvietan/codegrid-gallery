// scripts/rag/composition.mjs
// The composer's pure core: plan validation, the conflict matrix, slot selection,
// design-token normalization, and the build brief.
//
// This is where Frankenstein is actually prevented. Retrieval hands you eight
// sections that each looked right alone; assembled they fight — two of them hijack
// scroll, three lock the body, each brings its own font and its own raf loop. Two
// mechanisms fix that, and both live here:
//
//   1. A BUDGET, spent in slot order (admit / planSelection). A conflicting
//      component is rejected at selection time and the next-best one is taken —
//      never admitted and patched afterwards, because there is no patch for
//      "two components both own the scroll".
//   2. An ANCHOR (normalizeTokens). One pick's design tokens become the page's;
//      every other pick gets an explicit from->to rewrite map. Eight sections
//      become one system by rewriting seven, not by averaging eight.
//
// No I/O, no LLM — unit-tested offline.
import { ENUMS, SCOPE_OF_COMP_TYPE } from './schema.mjs';

// How many of each side effect a single page can survive. Absent = unlimited
// (but often worth an integration note — see integrationNotes).
export const SIDE_EFFECT_BUDGET = {
  scroll_hijack: 1,      // two = scroll dies
  canvas_fullscreen: 2,  // more = GPU dies on weak machines
};

// Two smooth-scroll libraries on one page is not a budget question, it is a reject.
const SMOOTH_SCROLL_LIBS = ['lenis', 'locomotive', 'scrollsmoother'];

/**
 * What the index can actually supply, as a line for the planner prompt.
 *
 * The first real composition run asked for an `about` section; the corpus holds
 * zero of them (also none for pricing, faq, stats — the annotator never reaches
 * for those labels). Planning a slot the index cannot fill is not a retrieval
 * failure to be reported later, it is a plan that was wrong when written. So the
 * planner is told the inventory, with counts, and types below `min` are omitted:
 * a single card of some type cannot survive the conflict budget rejecting it.
 */
export function inventoryOf(cards, min = 2) {
  const counts = {};
  for (const c of cards) counts[c.comp_type] = (counts[c.comp_type] || 0) + 1;
  return Object.entries(counts)
    .filter(([, n]) => n >= min)
    .sort((a, b) => b[1] - a[1]);
}

export function formatInventory(inventory) {
  return inventory.map(([type, n]) => `${type} (${n})`).join(', ');
}

export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['plan is not an object'] };
  if (typeof plan.title !== 'string' || !plan.title.trim()) errors.push('title: must be a non-empty string');
  if (!Array.isArray(plan.slots) || !plan.slots.length) {
    errors.push('slots: must be a non-empty array');
    return { ok: errors.length === 0, errors };
  }
  const seen = new Set();
  plan.slots.forEach((s, i) => {
    const at = `slots[${i}]`;
    if (!s || typeof s !== 'object') { errors.push(`${at}: not an object`); return; }
    if (typeof s.key !== 'string' || !s.key.trim()) errors.push(`${at}.key: must be a non-empty string`);
    else if (seen.has(s.key)) errors.push(`${at}.key: duplicate slot key "${s.key}"`);
    else seen.add(s.key);
    if (typeof s.intent !== 'string' || !s.intent.trim()) errors.push(`${at}.intent: must be a non-empty string`);
    if (!ENUMS.scope.includes(s.scope)) errors.push(`${at}.scope: "${s.scope}" not in enum scope`);
    if (!ENUMS.comp_type.includes(s.comp_type)) errors.push(`${at}.comp_type: "${s.comp_type}" not in enum comp_type`);
    else if (ENUMS.scope.includes(s.scope) && !SCOPE_OF_COMP_TYPE[s.scope].includes(s.comp_type)) {
      errors.push(`${at}.comp_type: "${s.comp_type}" does not belong to scope "${s.scope}"`);
    }
  });
  return { ok: errors.length === 0, errors };
}

/**
 * May this card join what is already selected? `commit` spends the budget.
 * Asking is free and side-effect free, so the selector can probe candidates in
 * rank order and only commit the one it takes.
 */
export function admit(state, card, commit = false) {
  const effects = card.side_effects || [];
  const libs = card.animation_libs || [];

  for (const e of effects) {
    if (e === 'body_overflow_lock' && card.scope !== 'overlay') {
      return { ok: false, reason: `body_overflow_lock is for overlays only — a ${card.scope} that locks the body means the page cannot scroll` };
    }
    const cap = SIDE_EFFECT_BUDGET[e];
    if (cap !== undefined && (state.counts[e] || 0) >= cap) {
      return { ok: false, reason: `${e} budget spent (max ${cap} per page)` };
    }
  }
  const incoming = libs.find((l) => SMOOTH_SCROLL_LIBS.includes(l));
  if (incoming) {
    const existing = [...state.libs].find((l) => SMOOTH_SCROLL_LIBS.includes(l) && l !== incoming);
    if (existing) return { ok: false, reason: `${existing} is already driving scroll — ${incoming} would fight it` };
  }

  if (commit) {
    for (const e of effects) state.counts[e] = (state.counts[e] || 0) + 1;
    for (const l of libs) state.libs.add(l);
  }
  return { ok: true, reason: '' };
}

export function newBudgetState() { return { counts: {}, libs: new Set() }; }

/**
 * Walk the slots in order, taking the highest-ranked candidate that survives the
 * budget. Slot order matters and that is intentional: the page's identity is set
 * top-down, so an early hero gets first claim on the scroll and a later section
 * has to earn its place with a component that cooperates.
 */
export function planSelection(slots, candidatesBySlot, state = newBudgetState(), minSim = 0) {
  const picks = [], rejected = [], unfilled = [];
  for (const slot of slots) {
    const candidates = candidatesBySlot[slot.key] || [];
    let taken = null, lastReason = 'no candidate survived the filters';
    for (const c of candidates) {
      // A weak match is a worse outcome than an empty slot: the slot gets filled,
      // the brief says "done", and nobody notices the page has a horizontal
      // scroll experiment standing in for smooth scrolling. Below the floor the
      // slot goes to "write fresh", where the technique index can serve it.
      if (minSim && (c.sim ?? 0) < minSim) {
        lastReason = `best match scored ${(c.sim ?? 0).toFixed(2)}, below the ${minSim} floor — nothing in the index really fits`;
        break;
      }
      const verdict = admit(state, c.card);
      if (verdict.ok) { taken = c; break; }
      rejected.push({ slot: slot.key, id: c.card.id, reason: verdict.reason });
      lastReason = verdict.reason;
    }
    if (!taken) { unfilled.push({ ...slot, reason: candidates.length ? lastReason : 'no candidate retrieved' }); continue; }
    admit(state, taken.card, true);
    picks.push({ slot, card: taken.card, sim: taken.sim });
  }
  return { picks, rejected, unfilled, state };
}

/**
 * Keep only the N strongest reuses; send the rest to fresh code.
 *
 * Measured, not assumed: letting the same composition build more reused sections
 * made it worse — photography went from 1 blocker at four sections to 3 at six,
 * agency from 0 at two to 2 at four. Each additional component brings another
 * finished design onto one page and the faults accumulate, so the number of
 * transplants is itself a dial. Strongest-first, because a 0.67 match earns its
 * seat and a 0.51 barely does.
 */
export function capReuse(selection, maxReuse) {
  if (!Number.isFinite(maxReuse) || maxReuse < 0) return selection;
  const ranked = [...selection.picks].sort((a, b) => (b.sim ?? 0) - (a.sim ?? 0));
  const keep = new Set(ranked.slice(0, maxReuse).map((p) => p.slot.key));
  const picks = selection.picks.filter((p) => keep.has(p.slot.key));
  const demoted = selection.picks.filter((p) => !keep.has(p.slot.key)).map((p) => ({
    ...p.slot,
    reason: `reuse capped at ${maxReuse} — ${p.card.id} matched at ${(p.sim ?? 0).toFixed(2)} but a page carries only so many borrowed designs`,
  }));
  return { ...selection, picks, unfilled: [...selection.unfilled, ...demoted] };
}

// ---------- design tokens ----------

const nearest = (value, scale) => scale.reduce((best, c) =>
  (Math.abs(c - value) < Math.abs(best - value) || (Math.abs(c - value) === Math.abs(best - value) && c < best) ? c : best), scale[0]);

/**
 * One system out of many. The ANCHOR is the first section pick — the page's
 * identity is set above the fold, so the hero's type and color win and everything
 * below is rewritten to it. Where the anchor is silent (null), the first later
 * pick that speaks fills the gap; nothing is averaged, because an averaged type
 * scale belongs to no design.
 */
export function normalizeTokens(picks) {
  if (!picks.length) return { anchorId: null, tokens: {}, rewrites: {} };
  const anchor = picks.find((p) => p.card.scope === 'section') || picks[0];
  const dt = (p) => p.card.design_tokens || {};
  const others = picks.filter((p) => p.card.id !== anchor.card.id);

  const fallback = (key) => {
    const a = dt(anchor)[key];
    if (a !== undefined && a !== null) return a;
    for (const p of others) {
      const v = dt(p)[key];
      if (v !== undefined && v !== null) return v;
    }
    return null;
  };

  const tokens = {};
  for (const key of ['fonts', 'type_scale_px', 'colors', 'spacing_unit_px', 'radius_px', 'max_width_px', 'grid_columns']) {
    tokens[key] = fallback(key);
  }
  // A null inside the anchor's color/font set should fall through too — the page
  // needs a background even if the hero card never named one.
  if (tokens.colors && typeof tokens.colors === 'object') {
    tokens.colors = { ...tokens.colors };
    for (const slotKey of ['bg', 'fg', 'accent']) {
      if (tokens.colors[slotKey] == null) {
        const found = others.map((p) => dt(p).colors?.[slotKey]).find((v) => v != null);
        if (found != null) tokens.colors[slotKey] = found;
      }
    }
  }

  const scale = Array.isArray(tokens.type_scale_px) ? tokens.type_scale_px : [];
  const canonicalFonts = Array.isArray(tokens.fonts) ? tokens.fonts : [];

  const rewrites = {};
  for (const p of others) {
    const t = dt(p);
    const map = {};

    if (t.colors && tokens.colors) {
      const colors = {};
      for (const k of ['bg', 'fg', 'accent']) {
        const from = t.colors[k], to = tokens.colors[k];
        if (from && to && from !== to) colors[from] = to;
      }
      if (Object.keys(colors).length) map.colors = colors;
    }

    if (Array.isArray(t.fonts) && canonicalFonts.length) {
      const fonts = {};
      t.fonts.forEach((f, i) => {
        if (!f?.family) return;
        const target = canonicalFonts.find((c) => c.role && c.role === f.role) || canonicalFonts[i] || canonicalFonts[0];
        if (target?.family && target.family !== f.family) fonts[f.family] = target.family;
      });
      if (Object.keys(fonts).length) map.fonts = fonts;
    }

    if (Array.isArray(t.type_scale_px) && scale.length) {
      const sizes = {};
      for (const s of t.type_scale_px) {
        const to = nearest(s, scale);
        if (to !== s) sizes[s] = to;
      }
      if (Object.keys(sizes).length) map.type_scale_px = sizes;
    }

    for (const k of ['spacing_unit_px', 'radius_px', 'max_width_px', 'grid_columns']) {
      if (t[k] != null && tokens[k] != null && t[k] !== tokens[k]) {
        map.scalars = { ...(map.scalars || {}), [k]: { from: t[k], to: tokens[k] } };
      }
    }

    if (Object.keys(map).length) rewrites[p.card.id] = map;
  }
  return { anchorId: anchor.card.id, tokens, rewrites };
}

// ---------- integration ----------

/** What survives selection but still has to be MERGED by hand after assembly. */
export function integrationNotes(picks) {
  const notes = [];
  const count = (e) => picks.filter((p) => (p.card.side_effects || []).includes(e)).length;

  const raf = count('own_raf_loop');
  if (raf > 1) notes.push(`${raf} components run their own requestAnimationFrame loop — merge them into a single ticker (gsap.ticker or one rAF that calls each update), or you drop frames on weaker machines.`);

  const st = count('scrolltrigger_register');
  if (st > 1) notes.push(`${st} components register ScrollTrigger — import and register GSAP once for the page, and call ScrollTrigger.refresh() AFTER every section is in the DOM, or the later triggers measure the wrong positions.`);

  const fixed = count('fixed_layer');
  if (fixed > 1) notes.push(`${fixed} components add a fixed layer — assign them one explicit z-index stack (cursor above overlay above nav) instead of letting DOM order decide.`);

  const resize = count('resize_listener');
  if (resize > 2) notes.push(`${resize} components listen to resize independently — debounce once at the page level and let them subscribe.`);

  const canvas = count('canvas_fullscreen');
  if (canvas > 1) notes.push(`${canvas} fullscreen canvases coexist — cap devicePixelRatio and make sure the lower one is pointer-events: none.`);

  return notes;
}

// ---------- the deliverable ----------

const fmt = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** The build brief: what to reuse verbatim, what to rewrite, what to write fresh. */
export function buildBrief(plan, selection, tokenPlan, techniquesBySlot = {}) {
  const L = [];
  L.push(`# ${plan.title}`, '');
  L.push(`${selection.picks.length}/${plan.slots.length} slots filled from the component index.`, '');

  L.push('## Design system (normalized)', '');
  L.push(`Anchor: \`${tokenPlan.anchorId ?? '—'}\` — its tokens are the page's; every other component is rewritten to them.`, '');
  for (const [k, v] of Object.entries(tokenPlan.tokens || {})) L.push(`- **${k}**: ${fmt(v)}`);
  L.push('');

  L.push('## Slots', '');
  for (const p of selection.picks) {
    L.push(`### ${p.slot.key} — \`${p.card.id}\` (${p.card.comp_type}, sim ${(p.sim ?? 0).toFixed(3)})`);
    L.push(`Intent: ${p.slot.intent}`);
    L.push(`Source: \`corpus/${p.card.id}/\` · libs: ${(p.card.animation_libs || []).join(', ') || 'none'}`);
    const rw = (tokenPlan.rewrites || {})[p.card.id];
    if (rw) L.push(`Rewrite before merging: ${JSON.stringify(rw)}`);
    const text = p.card.content_slots?.text;
    if (Array.isArray(text) && text.length) {
      L.push('Copy fits:');
      for (const t of text) L.push(`- \`${t.key}\` — max ${t.max_chars ?? '?'} chars${t.note ? ` (${t.note})` : ''}`);
    }
    L.push('');
  }

  if (selection.unfilled.length) {
    L.push('## Write these fresh', '');
    L.push('No component in the index fits, so do NOT force one — retrieve the mechanism and write new code, using the cited components only for exact syntax.', '');
    for (const u of selection.unfilled) {
      L.push(`### ${u.key} — ${u.comp_type}`);
      L.push(`Intent: ${u.intent}`);
      L.push(`Why not reused: ${u.reason}`);
      for (const t of techniquesBySlot[u.key] || []) {
        L.push(`- \`${t.id}\` — ${t.mechanism}${t.seen_in?.length ? ` · syntax in ${t.seen_in.slice(0, 3).join(', ')}` : ''}`);
      }
      L.push('');
    }
  }

  const notes = integrationNotes(selection.picks);
  if (notes.length) {
    L.push('## After assembly', '');
    for (const n of notes) L.push(`- ${n}`);
    L.push('');
  }

  if (selection.rejected.length) {
    L.push('## Rejected at selection (kept for the record)', '');
    for (const r of selection.rejected) L.push(`- \`${r.id}\` for **${r.slot}** — ${r.reason}`);
    L.push('');
  }
  return L.join('\n');
}
