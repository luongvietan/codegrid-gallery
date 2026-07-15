import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDiverse, cosine, applyFilters, rankLocal, buildRpcArgs, topKHit } from './retrieval.mjs';

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
