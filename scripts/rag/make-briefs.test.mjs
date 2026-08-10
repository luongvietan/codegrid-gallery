import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, buildBriefPrompt, validateGenBrief } from './make-briefs.mjs';

test('mulberry32 is deterministic for a seed and differs across seeds', () => {
  const a = [...Array(4)].map(mulberry32(7));
  const b = [...Array(4)].map(mulberry32(7));
  const c = [...Array(4)].map(mulberry32(8));
  assert.deepEqual(a, b);           // --seed makes a run reproducible
  assert.notDeepEqual(a, c);
  assert.ok(a.every((x) => x >= 0 && x < 1));
});

test('buildBriefPrompt forbids the vocabulary that would rig the eval', () => {
  const p = buildBriefPrompt('<h1>Acme</h1>');
  // A brief quoting the page's own copy or its library would match the card by
  // coincidence of wording rather than by describing the same thing.
  assert.match(p, /No brand names/i);
  assert.match(p, /No library names/i);
  assert.ok(p.includes('<h1>Acme</h1>'));
});

test('validateGenBrief enforces a sentence, not a word or an essay', () => {
  assert.equal(validateGenBrief({ query: 'dark hero where the headline rises line by line as you scroll' }).ok, true);
  assert.equal(validateGenBrief({ query: 'hero' }).ok, false);
  assert.equal(validateGenBrief({ query: 'x '.repeat(40) }).ok, false);
  assert.equal(validateGenBrief({}).ok, false);
});
