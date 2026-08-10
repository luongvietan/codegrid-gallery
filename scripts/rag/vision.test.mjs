import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEWPORTS, validateCritique, visionPayload, buildCritiquePrompt,
  mergeFindings, sortFindings, buildFixPlan,
} from './vision.mjs';

const finding = (over = {}) => ({
  severity: 'major', area: 'typography', slot: 'hero', viewport: 'desktop',
  what: 'The headline wraps to four lines and collides with the scroll cue.',
  fix: 'Drop the clamp max from 12vw to 9vw, or cut the headline to three words.',
  ...over,
});

const critique = (over = {}) => ({
  verdict: 'revise', score: 3, matches_brief: true, findings: [finding()], ...over,
});

const SLOTS = ['hero', 'work', 'contact'];

// ---------- schema ----------

test('validateCritique accepts a well-formed critique', () => {
  assert.deepEqual(validateCritique(critique(), SLOTS), { ok: true, errors: [] });
});

test('validateCritique rejects off-enum severity/area/verdict and an unknown slot', () => {
  const r = validateCritique(critique({
    verdict: 'looks_good',
    findings: [finding({ severity: 'catastrophic', area: 'vibes', slot: 'footer' })],
  }), SLOTS);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /looks_good/.test(e)));
  assert.ok(r.errors.some((e) => /catastrophic/.test(e)));
  assert.ok(r.errors.some((e) => /vibes/.test(e)));
  assert.ok(r.errors.some((e) => /footer/.test(e)));
});

test('validateCritique allows a finding that belongs to no single slot', () => {
  assert.equal(validateCritique(critique({ findings: [finding({ slot: null })] }), SLOTS).ok, true);
});

test('validateCritique enforces the score range and a non-empty fix', () => {
  assert.equal(validateCritique(critique({ score: 9 }), SLOTS).ok, false);
  assert.equal(validateCritique(critique({ score: 2.5 }), SLOTS).ok, false);
  const r = validateCritique(critique({ findings: [finding({ fix: '' })] }), SLOTS);
  assert.ok(r.errors.some((e) => /fix/.test(e)));
});

test('validateCritique catches "ship" contradicted by a blocker (the honesty check)', () => {
  const r = validateCritique(critique({ verdict: 'ship', findings: [finding({ severity: 'blocker' })] }), SLOTS);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /ship.*blocker/i.test(e)));
  // "ship" with nothing blocking is fine.
  assert.equal(validateCritique(critique({ verdict: 'ship', score: 5, findings: [finding({ severity: 'minor' })] }), SLOTS).ok, true);
});

// ---------- provider payloads ----------

const images = [
  { label: 'desktop', media_type: 'image/png', base64: 'AAAA' },
  { label: 'mobile', media_type: 'image/png', base64: 'BBBB' },
];

test('visionPayload builds Anthropic image blocks, images before the question', () => {
  const [msg] = visionPayload('anthropic', 'what is wrong?', images);
  assert.equal(msg.role, 'user');
  assert.deepEqual(msg.content[0], { type: 'text', text: 'desktop:' });
  assert.deepEqual(msg.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.equal(msg.content.at(-1).text, 'what is wrong?');
});

test('visionPayload builds OpenAI-compatible data URIs', () => {
  const [msg] = visionPayload('openai', 'what is wrong?', images);
  assert.deepEqual(msg.content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  assert.equal(msg.content.at(-1).type, 'text');
});

test('VIEWPORTS covers a desktop and a real mobile viewport', () => {
  assert.equal(VIEWPORTS.desktop.width, 1440);
  assert.ok(VIEWPORTS.mobile.width < 500);
  assert.equal(VIEWPORTS.mobile.isMobile, true);
});

test('buildCritiquePrompt states the brief, the slots and the refusal to be polite', () => {
  const p = buildCritiquePrompt('dark editorial studio site', SLOTS);
  assert.ok(p.includes('dark editorial studio site'));
  assert.ok(p.includes('hero, work, contact'));
  assert.match(p, /blocker|major|minor/);
});

// ---------- findings ----------

test('mergeFindings collapses the same problem seen on both viewports', () => {
  const desktop = [finding({ viewport: 'desktop' }), finding({ viewport: 'desktop', slot: 'work', what: 'Grid gutters differ.' })];
  const mobile = [finding({ viewport: 'mobile', what: 'The headline wraps to FOUR lines and collides with the scroll cue!' })];
  const merged = mergeFindings([...desktop, ...mobile]);

  assert.equal(merged.length, 2);
  assert.equal(merged.find((f) => f.slot === 'hero').viewport, 'both');
  assert.equal(merged.find((f) => f.slot === 'work').viewport, 'desktop');
});

test('mergeFindings keeps the worse severity when the two sightings disagree', () => {
  const merged = mergeFindings([
    finding({ viewport: 'desktop', severity: 'minor' }),
    finding({ viewport: 'mobile', severity: 'blocker' }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].severity, 'blocker');
});

test('sortFindings puts blockers first and is stable within a severity', () => {
  const list = [
    finding({ severity: 'minor', what: 'a' }), finding({ severity: 'blocker', what: 'b' }),
    finding({ severity: 'minor', what: 'c' }), finding({ severity: 'major', what: 'd' }),
  ];
  assert.deepEqual(sortFindings(list).map((f) => f.what), ['b', 'd', 'a', 'c']);
});

// ---------- the deliverable ----------

test('buildFixPlan routes every finding back to the component that owns it', () => {
  const composition = { picks: [{ slot: 'hero', id: 'src_hero' }, { slot: 'work', id: 'src_work' }] };
  const md = buildFixPlan(critique({
    findings: [
      finding({ severity: 'blocker', slot: 'work', what: 'Cards overflow the viewport on mobile.', viewport: 'mobile' }),
      finding(),
      finding({ slot: null, severity: 'minor', what: 'Two different accent reds appear.' }),
    ],
  }), composition, 'dark editorial studio site');

  assert.match(md, /blocker/i);
  assert.ok(md.indexOf('Cards overflow') < md.indexOf('headline wraps')); // blockers first
  assert.match(md, /src_work/);
  assert.match(md, /corpus\/src_hero\//);
  assert.match(md, /page-level|whole page/i);                            // the slotless finding still lands somewhere
});

test('buildFixPlan says so plainly when nothing is wrong', () => {
  const md = buildFixPlan({ verdict: 'ship', score: 5, matches_brief: true, findings: [] }, { picks: [] }, 'brief');
  assert.match(md, /ship/i);
  assert.doesNotMatch(md, /## Fixes/);
});
