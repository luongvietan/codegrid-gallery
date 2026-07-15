import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, countOccurrences, scoreDoc, firstMatchLine } from './corpus-query.mjs';

test('tokenize lowercases, splits, drops blanks', () => {
  assert.deepEqual(tokenize('  GSAP   ScrollTrigger '), ['gsap', 'scrolltrigger']);
  assert.deepEqual(tokenize(''), []);
});

test('countOccurrences counts non-overlapping matches', () => {
  assert.equal(countOccurrences('aaa', 'a'), 3);
  assert.equal(countOccurrences('ababab', 'ab'), 3);
  assert.equal(countOccurrences('none', 'x'), 0);
});

test('scoreDoc requires every term (AND) across path + body', () => {
  const body = 'const t = gsap.timeline(); t.to(el, { scrollTrigger: {} });';
  // both terms present (one in body twice, one once) -> matched
  const a = scoreDoc('proj/app.js', body, ['gsap', 'scrolltrigger']);
  assert.ok(a.matched && a.score > 0);
  // a term absent everywhere -> not matched
  const b = scoreDoc('proj/app.js', body, ['gsap', 'threejs']);
  assert.equal(b.matched, false);
  // path hit satisfies a term even if body lacks it
  const c = scoreDoc('proj/threejs/app.js', body, ['gsap', 'threejs']);
  assert.ok(c.matched);
});

test('scoreDoc rewards path hits and body density', () => {
  const sparse = scoreDoc('a.js', 'x gsap', ['gsap']);
  const dense = scoreDoc('a.js', 'gsap gsap gsap', ['gsap']);
  const inPath = scoreDoc('gsap/a.js', 'gsap', ['gsap']);
  assert.ok(dense.score > sparse.score);
  assert.ok(inPath.score > sparse.score);
});

test('firstMatchLine returns 1-indexed line and trimmed text', () => {
  const content = 'line one\n  const scrollTrigger = 1\nlast';
  const m = firstMatchLine(content, ['scrolltrigger']);
  assert.equal(m.lineNo, 2);
  assert.equal(m.text, 'const scrollTrigger = 1');
  assert.equal(firstMatchLine('nothing here', ['zzz']), null);
});
