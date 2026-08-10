import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePlan, admit, planSelection, normalizeTokens, integrationNotes, buildBrief,
} from './composition.mjs';

const plan = (over = {}) => ({
  title: 'Studio site',
  slots: [
    { key: 'top', scope: 'section', comp_type: 'nav', intent: 'thin fixed nav' },
    { key: 'hero', scope: 'section', comp_type: 'hero', intent: 'dark editorial hero' },
    { key: 'work', scope: 'section', comp_type: 'work_grid', intent: 'project grid' },
  ],
  ...over,
});

const card = (id, over = {}) => ({
  id, scope: 'section', comp_type: 'hero', framework: 'vanilla',
  animation_libs: ['gsap'], side_effects: [], aesthetic: ['editorial'],
  design_tokens: {}, content_slots: {}, ...over,
});

// ---------- plan ----------

test('validatePlan accepts a well-formed plan', () => {
  assert.deepEqual(validatePlan(plan()), { ok: true, errors: [] });
});

test('validatePlan rejects off-enum types and scope/comp_type mismatches', () => {
  const r = validatePlan(plan({
    slots: [
      { key: 'a', scope: 'section', comp_type: 'parallax_thing', intent: 'x' },
      { key: 'b', scope: 'section', comp_type: 'cursor', intent: 'x' },
    ],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /parallax_thing/.test(e)));
  assert.ok(r.errors.some((e) => /cursor.*scope "section"/.test(e)));
});

test('validatePlan rejects duplicate slot keys and an empty plan', () => {
  const dup = validatePlan(plan({ slots: [
    { key: 'hero', scope: 'section', comp_type: 'hero', intent: 'x' },
    { key: 'hero', scope: 'section', comp_type: 'about', intent: 'x' },
  ] }));
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some((e) => /duplicate slot key/.test(e)));
  assert.equal(validatePlan({ title: 't', slots: [] }).ok, false);
});

// ---------- the conflict matrix ----------

test('admit allows the first scroll_hijack and rejects the second', () => {
  const state = { counts: {}, libs: new Set() };
  const a = card('a', { side_effects: ['scroll_hijack'] });
  assert.equal(admit(state, a).ok, true);   // asking does not spend the budget
  assert.equal(admit(state, a).ok, true);
  admit(state, a, true);                    // committing does
  const second = admit(state, card('b', { side_effects: ['scroll_hijack'] }));
  assert.equal(second.ok, false);
  assert.match(second.reason, /scroll_hijack/);
});

test('admit lets only overlays lock body scroll', () => {
  const state = { counts: {}, libs: new Set() };
  const section = card('s', { scope: 'section', side_effects: ['body_overflow_lock'] });
  const overlay = card('o', { scope: 'overlay', comp_type: 'menu', side_effects: ['body_overflow_lock'] });
  assert.equal(admit(state, section).ok, false);
  assert.match(admit(state, section).reason, /overlay/);
  assert.equal(admit(state, overlay).ok, true);
});

test('admit caps fullscreen canvases at two', () => {
  const state = { counts: {}, libs: new Set() };
  const c = (id) => card(id, { side_effects: ['canvas_fullscreen'] });
  assert.equal(admit(state, c('1'), true).ok, true);
  assert.equal(admit(state, c('2'), true).ok, true);
  assert.equal(admit(state, c('3')).ok, false);
});

test('admit rejects a second smooth-scroll library', () => {
  const state = { counts: {}, libs: new Set() };
  assert.equal(admit(state, card('a', { animation_libs: ['lenis'] }), true).ok, true);
  const r = admit(state, card('b', { animation_libs: ['locomotive'] }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /lenis/);
  // The same library twice is fine — one instance, many users.
  assert.equal(admit(state, card('c', { animation_libs: ['lenis'] })).ok, true);
});

test('admit allows many raf loops and ScrollTrigger registrations (merged later)', () => {
  const state = { counts: {}, libs: new Set() };
  const c = (id) => card(id, { side_effects: ['own_raf_loop', 'scrolltrigger_register'] });
  assert.equal(admit(state, c('1'), true).ok, true);
  assert.equal(admit(state, c('2'), true).ok, true);
  assert.equal(admit(state, c('3')).ok, true);
});

// ---------- selection ----------

test('planSelection takes the best candidate that survives the budget', () => {
  const slots = plan().slots;
  const candidates = {
    top: [{ card: card('nav_1', { comp_type: 'nav', side_effects: ['fixed_layer'] }), sim: 0.9 }],
    hero: [
      { card: card('hero_hijack', { side_effects: ['scroll_hijack'] }), sim: 0.95 },
      { card: card('hero_plain'), sim: 0.7 },
    ],
    work: [
      // Best match hijacks scroll too — the hero already spent that budget.
      { card: card('work_hijack', { comp_type: 'work_grid', side_effects: ['scroll_hijack'] }), sim: 0.99 },
      { card: card('work_plain', { comp_type: 'work_grid' }), sim: 0.6 },
    ],
  };
  const sel = planSelection(slots, candidates);
  assert.deepEqual(sel.picks.map((p) => p.card.id), ['nav_1', 'hero_hijack', 'work_plain']);
  assert.equal(sel.unfilled.length, 0);
  assert.deepEqual(sel.rejected.map((r) => r.id), ['work_hijack']);
  assert.match(sel.rejected[0].reason, /scroll_hijack/);
});

test('planSelection reports a slot it could not fill, with the reason', () => {
  const slots = [{ key: 'hero', scope: 'section', comp_type: 'hero', intent: 'x' }];
  const sel = planSelection(slots, { hero: [] });
  assert.deepEqual(sel.picks, []);
  assert.deepEqual(sel.unfilled.map((u) => u.key), ['hero']);

  const blocked = planSelection(slots, {
    hero: [{ card: card('h', { scope: 'section', side_effects: ['body_overflow_lock'] }), sim: 1 }],
  });
  assert.deepEqual(blocked.unfilled.map((u) => u.key), ['hero']);
  assert.match(blocked.unfilled[0].reason, /overlay/);
});

// ---------- token normalization ----------

const tokens = (over = {}) => ({
  fonts: [{ family: 'Söhne', role: 'display', weights: [400, 700] }],
  type_scale_px: [16, 24, 64],
  colors: { bg: '#000000', fg: '#ffffff', accent: '#ff3b00' },
  spacing_unit_px: 8, radius_px: 0, max_width_px: 1440, grid_columns: 12, ...over,
});

test('normalizeTokens makes the first section pick the anchor and rewrites the rest to it', () => {
  const picks = [
    { slot: { key: 'hero' }, card: card('hero_1', { design_tokens: tokens() }) },
    { slot: { key: 'work' }, card: card('work_1', { comp_type: 'work_grid', design_tokens: tokens({
      fonts: [{ family: 'Inter', role: 'display', weights: [400] }],
      colors: { bg: '#111111', fg: '#eeeeee', accent: '#ff3b00' },
      type_scale_px: [15, 26],
      spacing_unit_px: 10,
    }) }) },
  ];
  const { anchorId, tokens: t, rewrites } = normalizeTokens(picks);

  assert.equal(anchorId, 'hero_1');
  assert.equal(t.spacing_unit_px, 8);
  assert.deepEqual(t.colors, tokens().colors);

  const r = rewrites.work_1;
  assert.deepEqual(r.colors, { '#111111': '#000000', '#eeeeee': '#ffffff' }); // accent already matches
  assert.deepEqual(r.fonts, { Inter: 'Söhne' });
  assert.deepEqual(r.type_scale_px, { 15: 16, 26: 24 }); // snapped to the canonical scale
  assert.equal(rewrites.hero_1, undefined); // the anchor rewrites nothing
});

test('normalizeTokens fills an anchor gap from the next pick that speaks', () => {
  const picks = [
    { slot: { key: 'hero' }, card: card('a', { design_tokens: tokens({ max_width_px: null, radius_px: null }) }) },
    { slot: { key: 'work' }, card: card('b', { comp_type: 'work_grid', design_tokens: tokens({ max_width_px: 1200 }) }) },
  ];
  const { tokens: t } = normalizeTokens(picks);
  assert.equal(t.max_width_px, 1200);
  assert.equal(t.radius_px, 0);
});

test('normalizeTokens survives components that declare no tokens', () => {
  const { tokens: t, rewrites } = normalizeTokens([{ slot: { key: 'hero' }, card: card('bare') }]);
  assert.equal(typeof t, 'object');
  assert.deepEqual(rewrites, {});
});

// ---------- integration notes ----------

test('integrationNotes names every merge the assembler must actually perform', () => {
  const picks = [
    { card: card('a', { side_effects: ['own_raf_loop', 'scrolltrigger_register'], animation_libs: ['gsap', 'scrolltrigger'] }) },
    { card: card('b', { side_effects: ['own_raf_loop', 'scrolltrigger_register'], animation_libs: ['gsap', 'scrolltrigger'] }) },
    { card: card('c', { side_effects: ['resize_listener', 'fixed_layer'] }) },
    { card: card('d', { side_effects: ['fixed_layer'] }) },
  ];
  const notes = integrationNotes(picks).join('\n');
  assert.match(notes, /2 components run their own requestAnimationFrame/);
  assert.match(notes, /ScrollTrigger\.refresh\(\)/);
  assert.match(notes, /z-index/);
  assert.equal(integrationNotes([{ card: card('solo') }]).length, 0);
});

// ---------- the deliverable ----------

test('buildBrief carries picks, rewrites, unfilled slots and their techniques', () => {
  const sel = {
    picks: [{ slot: { key: 'hero', intent: 'dark editorial hero' }, card: card('hero_1', {
      content_slots: { text: [{ key: 'headline', max_chars: 24, note: 'three words' }] },
    }), sim: 0.8 }],
    unfilled: [{ key: 'work', comp_type: 'work_grid', intent: 'project grid', reason: 'no candidate' }],
    rejected: [{ slot: 'work', id: 'work_hijack', reason: 'scroll_hijack budget spent' }],
  };
  const techniques = { work: [{ id: 'tech_pinned_scrub', mechanism: 'pin + scrub', seen_in: ['src_9'] }] };
  const md = buildBrief(plan(), sel, normalizeTokens(sel.picks), techniques);

  assert.match(md, /hero_1/);
  assert.match(md, /max 24 chars/);
  assert.match(md, /tech_pinned_scrub/);
  assert.match(md, /src_9/);
  assert.match(md, /work_hijack/);       // rejections are shown, not hidden
  assert.match(md, /scroll_hijack budget spent/);
});
