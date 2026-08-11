import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSectionPrompt, validateSection, generateSection } from './generation.mjs';

const spec = {
  slot: { key: 'process', comp_type: 'process', intent: 'three steps that reveal as you scroll' },
  tokens: { colors: { bg: '#0f0f0f', fg: '#ffffff', accent: '#ff3b00' }, fonts: [{ family: 'DM Sans', role: 'body' }], type_scale_px: [16, 24, 64], spacing_unit_px: 16 },
  techniques: [{ id: 'tech_masked_line_lift', name: 'Masked line lift', mechanism: 'wrap each line, translateY from 100% with overflow hidden', params: { stagger: [0.05, 0.12] } }],
  excerpts: { tech_masked_line_lift: 'gsap.from(lines, { yPercent: 100, stagger: 0.08 })' },
};

const section = (over = {}) => ({ html: '<h2 class="p-title">How we work</h2>', css: '.p-title { color: #fff; }', js: '', notes: 'x', ...over });

test('buildSectionPrompt carries the page tokens, the intent and the technique code', () => {
  const p = buildSectionPrompt(spec);
  assert.ok(p.includes('three steps that reveal as you scroll'));
  assert.ok(p.includes('#0f0f0f') && p.includes('DM Sans'));
  assert.ok(p.includes('Masked line lift'));
  assert.ok(p.includes('gsap.from(lines'));            // real syntax to copy from
  assert.match(p, /do not copy its markup/i);           // ...but not its content
});

test('buildSectionPrompt survives a slot with no techniques retrieved', () => {
  const p = buildSectionPrompt({ ...spec, techniques: [], excerpts: {} });
  assert.ok(p.includes('none retrieved'));
});

test('validateSection accepts a well-formed section', () => {
  assert.deepEqual(validateSection(section(), 'process'), { ok: true, errors: [] });
});

test('validateSection refuses a section that styles the document', () => {
  // The whole point of generating rather than transplanting is not to inherit
  // the fight over globals.
  for (const bad of ['body { background: #000; }', ':root { --x: 1px; }', 'html, .a { color: red; }']) {
    const r = validateSection(section({ css: bad }), 'process');
    assert.equal(r.ok, false, bad);
    assert.ok(r.errors.some((e) => /does not own html\/body\/:root/.test(e)), bad);
  }
  // A class that merely mentions body in its name is fine.
  assert.equal(validateSection(section({ css: '.body-copy { color: red; }' }), 'process').ok, true);
});

test('validateSection refuses document scaffolding and inline tags in html', () => {
  for (const [bad, re] of [
    ['<body><h2>x</h2></body>', /<html>, <head> or <body>/],
    ['<h2>x</h2><style>.a{}</style>', /<style>/],
    ['<h2>x</h2><script>a()</script>', /<script>/],
    ['<link rel="stylesheet" href="a.css"><h2>x</h2>', /<link>/],
  ]) {
    const r = validateSection(section({ html: bad }), 'process');
    assert.equal(r.ok, false, bad);
    assert.ok(r.errors.some((e) => re.test(e)), `${bad} -> ${r.errors}`);
  }
});

test('validateSection refuses external resources anywhere', () => {
  assert.equal(validateSection(section({ css: '@import url(x.css);' }), 'p').ok, false);
  assert.equal(validateSection(section({ css: '.a { background: url(https://cdn/x.png); }' }), 'p').ok, false);
  assert.equal(validateSection(section({ html: '<img src="https://cdn/x.png">' }), 'p').ok, false);
  assert.equal(validateSection(section({ js: 'import("gsap")' }), 'p').ok, false);
});

test('generateSection retries with the errors and returns the corrected section', async () => {
  const replies = [
    JSON.stringify(section({ css: 'body { background: #000; }' })),   // styles the document
    JSON.stringify(section({ js: 'gsap.from(".p-title", { yPercent: 100 })' })),
  ];
  const seen = [];
  const chat = async (messages) => { seen.push(messages); return replies.shift(); };

  const out = await generateSection(chat, spec);
  assert.equal(out.js, 'gsap.from(".p-title", { yPercent: 100 })');
  assert.equal(out.css, '.p-title { color: #fff; }');
  assert.ok(JSON.stringify(seen.at(-1)).includes('does not own html'));
});

test('generateSection gives up loudly rather than returning something invalid', async () => {
  const chat = async () => JSON.stringify(section({ html: '<body>x</body>' }));
  await assert.rejects(() => generateSection(chat, spec), /section generation failed/);
});

test('validateSection rejects a static import, not just a dynamic one', () => {
  // Caught in the browser: a generated section used `import gsap from "gsap"`,
  // threw "Cannot use import statement outside a module", and died silently.
  assert.equal(validateSection(section({ js: 'import gsap from "gsap";\ngsap.to(1)' }), 'p').ok, false);
  assert.equal(validateSection(section({ js: 'import "./a.css"' }), 'p').ok, false);
  assert.equal(validateSection(section({ js: 'export const a = 1' }), 'p').ok, false);
  assert.equal(validateSection(section({ js: 'gsap.to(".x", { y: 0 })' }), 'p').ok, true);
});

test('validateSection rejects a font the direction never chose', () => {
  // The prompt already said not to; it happened anyway. A section asked for
  // "Monument Extended", nothing loaded it, and the page rendered in Helvetica.
  const allowed = ['Space Grotesk', 'ui-sans-serif, system-ui, sans-serif'];
  const bad = validateSection(section({ css: '.t { font-family: "Monument Extended", sans-serif; }' }), 'p', allowed);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /Monument Extended.*not one the direction chose/.test(e)));

  assert.equal(validateSection(section({ css: '.t { font-family: "Space Grotesk", sans-serif; }' }), 'p', allowed).ok, true);
  assert.equal(validateSection(section({ css: '.t { font-family: system-ui, sans-serif; }' }), 'p', allowed).ok, true);
  // With no direction there is nothing to enforce.
  assert.equal(validateSection(section({ css: '.t { font-family: Whatever; }' }), 'p').ok, true);
});
