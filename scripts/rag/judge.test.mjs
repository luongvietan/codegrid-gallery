import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJudgePrompt, validateVerdicts, judgeBrief, precisionAt, summarize,
} from './judge.mjs';

const card = (id, description) => ({ id, comp_type: 'hero', description });
const cards = [
  card('a', 'A dark hero whose headline splits into lines that rise on load.'),
  card('b', 'A pricing table with three columns.'),
];

test('buildJudgePrompt shows the brief and every candidate by id', () => {
  const p = buildJudgePrompt('dark editorial hero', cards);
  assert.ok(p.includes('dark editorial hero'));
  assert.ok(p.includes('a') && p.includes('b'));
  assert.ok(p.includes('pricing table with three columns'));
  assert.match(p, /relevant/i);
});

test('validateVerdicts demands a verdict for exactly the candidates', () => {
  assert.equal(validateVerdicts({ verdicts: [{ id: 'a', relevant: true, why: 'x' }, { id: 'b', relevant: false, why: 'y' }] }, ['a', 'b']).ok, true);

  const missing = validateVerdicts({ verdicts: [{ id: 'a', relevant: true, why: 'x' }] }, ['a', 'b']);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => /missing.*b/.test(e)));

  const extra = validateVerdicts({ verdicts: [{ id: 'a', relevant: true, why: 'x' }, { id: 'b', relevant: true, why: 'y' }, { id: 'zz', relevant: true, why: 'z' }] }, ['a', 'b']);
  assert.equal(extra.ok, false);
  assert.ok(extra.errors.some((e) => /zz/.test(e)));
});

test('validateVerdicts rejects a non-boolean verdict and an empty reason', () => {
  const r = validateVerdicts({ verdicts: [{ id: 'a', relevant: 'yes', why: '' }, { id: 'b', relevant: false, why: 'y' }] }, ['a', 'b']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /relevant/.test(e)));
  assert.ok(r.errors.some((e) => /why/.test(e)));
});

test('judgeBrief returns verdicts and retries when the model answers badly', async () => {
  const replies = [
    JSON.stringify({ verdicts: [{ id: 'a', relevant: true, why: 'matches' }] }),          // incomplete
    JSON.stringify({ verdicts: [{ id: 'a', relevant: true, why: 'dark hero, text rises' },
      { id: 'b', relevant: false, why: 'a pricing table, not a hero' }] }),
  ];
  const seen = [];
  const chat = async (messages) => { seen.push(messages); return replies.shift(); };

  const out = await judgeBrief(chat, 'dark editorial hero', cards);
  assert.equal(out.length, 2);
  assert.equal(out[0].relevant, true);
  assert.equal(out[1].relevant, false);
  assert.ok(JSON.stringify(seen.at(-1)).includes('missing'));
});

test('precisionAt counts relevant results out of what was returned', () => {
  assert.equal(precisionAt([{ relevant: true }, { relevant: false }, { relevant: true }]), 2 / 3);
  assert.equal(precisionAt([]), 0);
});

test('summarize reports mean precision and how many briefs returned nothing useful', () => {
  const s = summarize([
    { query: 'q1', verdicts: [{ relevant: true }, { relevant: true }, { relevant: false }] },
    { query: 'q2', verdicts: [{ relevant: false }, { relevant: false }, { relevant: false }] },
  ]);
  assert.equal(s.briefs, 2);
  assert.ok(Math.abs(s.meanPrecision - (2 / 3 + 0) / 2) < 1e-9);
  assert.equal(s.shutouts, 1);          // a brief where nothing relevant came back
  assert.equal(s.anyRelevant, 1);       // "at least one usable result" — the composer's real question
});
