import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDiverse, cosine, applyFilters, rankLocal, rankTechniques, buildRpcArgs, topKHit, topKHitAny } from './retrieval.mjs';

const card = (id, over = {}) => ({
  id, comp_type: 'hero', framework: 'vanilla', animation_libs: ['gsap'],
  aesthetic: ['editorial'], side_effects: [], scope: 'section', embedding: [1, 0, 0], ...over,
});

test('selectDiverse spreads across signatures before repeating one', () => {
  const cards = [
    card('a', { comp_type: 'hero' }),
    card('b', { comp_type: 'hero' }),          // same signature as a
    card('c', { comp_type: 'footer' }),
    card('d', { comp_type: 'gallery', animation_libs: ['three'] }),
  ];
  const picked = selectDiverse(cards, 3).map((c) => c.id);
  // First three should be one-per-distinct-signature: a, c, d (not a then b).
  assert.deepEqual(picked, ['a', 'c', 'd']);
});

test('cosine: identical vectors ~1, orthogonal 0', () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  assert.equal(cosine([1, 0], [1]), -1); // length mismatch guarded
});

test('applyFilters enforces scope/comp_type and aesthetic overlap', () => {
  assert.equal(applyFilters(card('a'), { scope: 'section', compType: 'hero' }), true);
  assert.equal(applyFilters(card('a'), { compType: 'footer' }), false);
  assert.equal(applyFilters(card('a', { aesthetic: ['minimal'] }), { aesthetic: ['editorial'] }), false);
});

test('applyFilters rejects side-effect and anim-lib conflicts (retriever tier)', () => {
  const hijacker = card('h', { side_effects: ['scroll_hijack'] });
  assert.equal(applyFilters(hijacker, { excludeSideEffects: ['scroll_hijack'] }), false);
  const loco = card('l', { animation_libs: ['locomotive'] });
  assert.equal(applyFilters(loco, { excludeAnimLibs: ['locomotive'] }), false);
});

test('rankLocal filters then orders by cosine and honors limit', () => {
  const cards = [
    card('near', { embedding: [1, 0, 0] }),
    card('far', { embedding: [0, 1, 0] }),
    card('wrong', { comp_type: 'footer', embedding: [1, 0, 0] }),
  ];
  const ranked = rankLocal(cards, [1, 0, 0], { compType: 'hero' }, 5);
  assert.deepEqual(ranked.map((r) => r.card.id), ['near', 'far']); // 'wrong' filtered out
  assert.ok(ranked[0].sim > ranked[1].sim);
});

test('rankTechniques filters on stack only, then orders by cosine', () => {
  const t = (id, libs, emb) => ({ id, animation_libs: libs, embedding: emb, seen_in: ['src_001'] });
  const techniques = [
    t('tech_a', ['gsap'], [1, 0, 0]),
    t('tech_b', ['gsap'], [0.7, 0.7, 0]),
    t('tech_c', ['locomotive'], [1, 0, 0]),
    t('tech_d', ['three'], [1, 0, 0]),
  ];
  const ranked = rankTechniques(techniques, [1, 0, 0], { excludeAnimLibs: ['locomotive'] }, 5);
  assert.deepEqual(ranked.map((r) => r.card.id), ['tech_a', 'tech_d', 'tech_b']);

  const only = rankTechniques(techniques, [1, 0, 0], { animLibs: ['three'] }, 5);
  assert.deepEqual(only.map((r) => r.card.id), ['tech_d']);
});

test('buildRpcArgs maps a brief to nullable RPC args', () => {
  assert.deepEqual(buildRpcArgs({ scope: 'section', compType: 'hero', aesthetic: ['editorial'], excludeSideEffects: ['scroll_hijack'], limit: 5 }), {
    f_scope: 'section', f_comp_type: 'hero', f_aesthetic: ['editorial'],
    f_exclude_side_effects: ['scroll_hijack'], f_exclude_anim_libs: null, match_limit: 5,
  });
  assert.deepEqual(buildRpcArgs({}), {
    f_scope: null, f_comp_type: null, f_aesthetic: null,
    f_exclude_side_effects: null, f_exclude_anim_libs: null, match_limit: 5,
  });
});

test('topKHit checks the expected id is in the top k', () => {
  const ranked = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
  assert.equal(topKHit(ranked, 'z', 3), true);
  assert.equal(topKHit(ranked, 'z', 2), false);
});

test('topKHitAny accepts any of several equally correct answers', () => {
  // At 422 cards a brief like "photo grid animating in on scroll" has a dozen
  // right answers; scoring against one arbitrary id measures the wrong thing.
  const ranked = [{ card: { id: 'a' } }, { card: { id: 'b' } }, { card: { id: 'c' } }];
  assert.equal(topKHitAny(ranked, ['q', 'b'], 3), true);
  assert.equal(topKHitAny(ranked, ['q', 'c'], 2), false);
  assert.equal(topKHitAny(ranked, [null, undefined], 3), false);
});

test('applyFilters can hold the page to one colour mood', () => {
  // A "dark editorial" brief that picks a light hero makes it the anchor, and
  // every other section is then rewritten to the wrong palette.
  const dark = card('d', { color_mood: 'dark' });
  const light = card('l', { color_mood: 'light' });
  assert.equal(applyFilters(dark, { colorMood: 'dark' }), true);
  assert.equal(applyFilters(light, { colorMood: 'dark' }), false);
  assert.equal(applyFilters(light, {}), true);
});

test('applyFilters can refuse sections that only work with a pointer', () => {
  // Found by critiquing a real assembled page: the work slot was a cursor-trail
  // component, so every mobile frame below the hero was an empty black screen.
  const trail = card('t', { motion_character: ['cursor_follow'] });
  const hoverOnly = card('h', { motion_character: ['hover_driven'] });
  const scroll = card('s', { motion_character: ['scroll_driven', 'hover_driven'] });
  const cursorGlobal = card('c', { scope: 'global', comp_type: 'cursor', motion_character: ['cursor_follow'] });

  assert.equal(applyFilters(trail, { touchSafe: true }), false);
  assert.equal(applyFilters(hoverOnly, { touchSafe: true }), false);
  assert.equal(applyFilters(scroll, { touchSafe: true }), true);   // hover is an enhancement here
  assert.equal(applyFilters(cursorGlobal, { touchSafe: true }), true); // a cursor is allowed to be a cursor
  assert.equal(applyFilters(trail, {}), true);
});
