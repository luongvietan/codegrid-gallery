import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectionPrompt, validateDirection, directionBrief, directPage } from './direction.mjs';

const slots = [
  { key: 'hero', comp_type: 'hero', intent: 'a' },
  { key: 'work', comp_type: 'work_grid', intent: 'b' },
  { key: 'contact', comp_type: 'contact', intent: 'c' },
  { key: 'footer', comp_type: 'footer', intent: 'd' },
];
const keys = slots.map((s) => s.key);

const direction = (over = {}) => ({
  idea: 'The work is the only thing in colour; everything else is set in grey.',
  palette: { bg: '#0d0d0d', fg: '#e8e8e8', accent: '#ff4a1c', muted: '#6b6b6b', accent_rule: 'once per screen, only on the active project' },
  type: { display: { family: 'Archivo', weight: 700, case: 'uppercase', tracking: '-0.02em' }, body: { family: 'Inter', weight: 400 }, scale_ratio: 1.5, max_measure_ch: 68 },
  motion_signature: 'Everything enters by a mask wipe from the left, 0.6s, power3.out.',
  signature_moment: { slot: 'work', what: 'the grid collapses into a single frame as you scroll' },
  rhythm: [
    { slot: 'hero', density: 'sparse', height: 'full', role: 'state the idea and stop' },
    { slot: 'work', density: 'dense', height: 'tall', role: 'carry the page' },
    { slot: 'contact', density: 'sparse', height: 'auto', role: 'breathe, then ask' },
    { slot: 'footer', density: 'balanced', height: 'auto', role: 'close quietly' },
  ],
  rules: ['body text never centred', 'one accent element per screen', 'images bleed off one edge'],
  ...over,
});

test('buildDirectionPrompt demands a point of view, not adjectives', () => {
  const p = buildDirectionPrompt('a studio site', slots, { colors: { bg: '#000', fg: '#fff', accent: '#f30' } });
  assert.ok(p.includes('hero (hero)'));
  assert.match(p, /through-line/i);
  assert.match(p, /Not "modern and clean"/);
  assert.ok(p.includes('#000'));            // what the picked components suggest
  assert.match(p, /overrule them/);         // ...and permission to ignore it
});

test('validateDirection accepts a real direction', () => {
  assert.deepEqual(validateDirection(direction(), keys), { ok: true, errors: [] });
});

test('validateDirection rejects vibes in place of an idea', () => {
  // "modern and clean" is the failure mode this whole step exists to prevent.
  const r = validateDirection(direction({ idea: 'A modern, clean and elegant layout for the studio.' }), keys);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not a point of view/.test(e)));
  assert.equal(validateDirection(direction({ idea: 'Bold and airy' }), keys).ok, false);
});

test('validateDirection insists an accent be rare and a ratio be one number', () => {
  assert.ok(validateDirection(direction({ palette: { ...direction().palette, accent_rule: '' } }), keys)
    .errors.some((e) => /accent_rule/.test(e)));
  assert.ok(validateDirection(direction({ type: { ...direction().type, scale_ratio: 3 } }), keys)
    .errors.some((e) => /scale_ratio/.test(e)));
});

test('validateDirection requires one motion mechanism, not a list of them', () => {
  const r = validateDirection(direction({ motion_signature: ['fade', 'slide', 'scale'] }), keys);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /motion_signature/.test(e)));
});

test('validateDirection covers every section and refuses a flat rhythm', () => {
  const missing = validateDirection(direction({ rhythm: direction().rhythm.slice(0, 2) }), keys);
  assert.ok(missing.errors.some((e) => /missing an entry for "contact"/.test(e)));

  // Every section full-height is the list this step exists to break up.
  const flat = validateDirection(direction({
    rhythm: direction().rhythm.map((r) => ({ ...r, height: 'full' })),
  }), keys);
  assert.equal(flat.ok, false);
  assert.ok(flat.errors.some((e) => /is a list, not a rhythm/.test(e)));
});

test('validateDirection checks the signature moment names a real section', () => {
  const r = validateDirection(direction({ signature_moment: { slot: 'nope', what: 'x' } }), keys);
  assert.ok(r.errors.some((e) => /not one of/.test(e)));
});

test('directionBrief tells a section what it owes the page', () => {
  const carrier = directionBrief(direction(), 'work');
  assert.match(carrier, /CARRIES THE SIGNATURE MOMENT/);
  assert.match(carrier, /density dense, height tall/);

  const supporting = directionBrief(direction(), 'contact');
  assert.match(supporting, /stay quieter than it/);
  assert.match(supporting, /once per screen/);           // the accent rule travels with it
  assert.match(supporting, /mask wipe from the left/);   // so does the one motion
});

test('directPage retries with the errors and returns the corrected direction', async () => {
  const replies = [
    JSON.stringify(direction({ idea: 'A clean and modern studio page.' })),
    JSON.stringify(direction()),
  ];
  const seen = [];
  const chat = async (m) => { seen.push(m); return replies.shift(); };
  const out = await directPage(chat, 'a studio site', slots);
  assert.equal(out.idea, direction().idea);
  assert.ok(JSON.stringify(seen.at(-1)).includes('not a point of view'));
});

test('validateDirection refuses one flat face for both roles', () => {
  // A real direction produced ui-sans-serif for display AND body: technically
  // valid, and exactly what "lifeless" looks like in a direction file.
  const flat = { display: { family: 'ui-sans-serif' }, body: { family: 'ui-sans-serif' }, scale_ratio: 1.6 };
  assert.ok(validateDirection(direction({ type: flat }), keys).errors.some((e) => /same face with no contrast/.test(e)));

  // Same family is fine when the display face is doing something the body never does.
  const weighted = { display: { family: 'Inter', weight: 800 }, body: { family: 'Inter', weight: 400 }, scale_ratio: 1.5 };
  assert.equal(validateDirection(direction({ type: weighted }), keys).ok, true);
  const cased = { display: { family: 'Inter', case: 'uppercase' }, body: { family: 'Inter' }, scale_ratio: 1.5 };
  assert.equal(validateDirection(direction({ type: cased }), keys).ok, true);
});
