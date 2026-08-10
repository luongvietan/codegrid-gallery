import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugifyTechniqueId, validateTechnique, normalizeParams, mergeParamValue,
  mergeTechnique, techniqueEmbeddingText, buildTechniquePrompt, extractTechniques,
  emptyRegistry, addToRegistry, registryLinks, knownNamesOf,
} from './techniques.mjs';
import { extractJson } from './llm.mjs';

const tech = (over = {}) => ({
  name: 'Staggered char reveal',
  mechanism: 'split headline into chars -> gsap.from with stagger, driven by ScrollTrigger',
  animation_libs: ['gsap', 'splittext', 'scrolltrigger'],
  params: { stagger: [0.02, 0.05], y: 40, ease: 'power3.out' },
  variations: ['reveal by word instead of char', 'clip-path wipe per line'],
  description: 'Letters of a headline rise into place one after another as the block enters view, so the line assembles left to right instead of appearing at once.',
  retrieval_probes: ['headline animates in letter by letter', 'text reveals on scroll', 'staggered type entrance'],
  ...over,
});

test('slugifyTechniqueId makes a stable tech_ id', () => {
  assert.equal(slugifyTechniqueId('Staggered char reveal'), 'tech_staggered_char_reveal');
  assert.equal(slugifyTechniqueId('  Pinned  section + scrub!! '), 'tech_pinned_section_scrub');
  // Same technique named with different casing/punctuation collapses to one id.
  assert.equal(slugifyTechniqueId('Magnetic-Button'), slugifyTechniqueId('magnetic button'));
});

test('validateTechnique accepts a well-formed technique', () => {
  assert.deepEqual(validateTechnique(tech()), { ok: true, errors: [] });
});

test('validateTechnique rejects off-enum libs, bad probe count, empty text', () => {
  const bad = validateTechnique(tech({
    animation_libs: ['gsap', 'greensock'],
    retrieval_probes: ['only one'],
    mechanism: '   ',
  }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /greensock/.test(e)));
  assert.ok(bad.errors.some((e) => /retrieval_probes/.test(e)));
  assert.ok(bad.errors.some((e) => /mechanism/.test(e)));
});

test('validateTechnique rejects a params value that is not a number/string/array', () => {
  const r = validateTechnique(tech({ params: { ease: { nested: true } } }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /params\.ease/.test(e)));
});

test('normalizeParams turns scalars into ranges and strings into lists', () => {
  assert.deepEqual(normalizeParams({ y: 40, stagger: [0.05, 0.02], ease: 'power3.out' }), {
    y: [40, 40],
    stagger: [0.02, 0.05],
    ease: ['power3.out'],
  });
});

test('mergeParamValue widens numeric ranges and unions string lists', () => {
  assert.deepEqual(mergeParamValue([0.02, 0.05], [0.01, 0.2]), [0.01, 0.2]);
  assert.deepEqual(mergeParamValue(['power3.out'], ['expo.out', 'power3.out']), ['power3.out', 'expo.out']);
  // Mixed kinds degrade to a string list rather than throwing away data.
  assert.deepEqual(mergeParamValue([0, 1], ['auto']), ['0', '1', 'auto']);
});

test('mergeTechnique unions libs/variations/probes, widens params, appends seen_in', () => {
  const a = { ...tech(), id: 'tech_staggered_char_reveal', seen_in: ['src_001'], sources: 1 };
  const b = tech({
    animation_libs: ['gsap', 'scrolltrigger'],
    params: { stagger: [0.01, 0.03], duration: 1.2 },
    variations: ['reveal by word instead of char', 'blur out on exit'],
    retrieval_probes: ['type builds itself', 'letters slide up on scroll', 'kinetic headline'],
    description: 'A different wording of the same effect.',
  });
  const m = mergeTechnique(a, b, 'src_002');

  assert.deepEqual(m.seen_in, ['src_001', 'src_002']);
  assert.equal(m.sources, 2);
  assert.deepEqual(m.animation_libs, ['gsap', 'splittext', 'scrolltrigger']);
  assert.deepEqual(m.params.stagger, [0.01, 0.05]);
  assert.deepEqual(m.params.duration, [1.2, 1.2]);
  assert.equal(m.variations.length, 3);
  assert.ok(m.retrieval_probes.length <= 5);
  // First writer wins on prose, so the stored embedding never silently goes stale.
  assert.equal(m.description, tech().description);
});

test('mergeTechnique is idempotent for a component already seen', () => {
  const a = { ...tech(), id: 'tech_x', seen_in: ['src_001'], sources: 1 };
  const m = mergeTechnique(a, tech(), 'src_001');
  assert.deepEqual(m.seen_in, ['src_001']);
  assert.equal(m.sources, 1);
});

test('techniqueEmbeddingText embeds effect + mechanism + probes, never the code', () => {
  const t = techniqueEmbeddingText(tech());
  assert.ok(t.includes('Letters of a headline'));
  assert.ok(t.includes('split headline into chars'));
  assert.ok(t.includes('staggered type entrance'));
});

test('buildTechniquePrompt names the known vocabulary so ids converge', () => {
  const p = buildTechniquePrompt({ id: 'src_009', comp_type: 'hero', description: 'a hero', code: 'gsap.to()' },
    ['Staggered char reveal', 'Magnetic button']);
  assert.ok(p.includes('Staggered char reveal'));
  assert.ok(p.includes('Magnetic button'));
  assert.ok(p.includes('gsap.to()'));
});

test('extractTechniques validates and retries on a bad first response', async () => {
  const replies = [
    'not json at all',
    JSON.stringify({ techniques: [tech({ animation_libs: ['greensock'] })] }),
    JSON.stringify({ techniques: [tech(), tech({ name: 'Magnetic button' })] }),
  ];
  const seen = [];
  const chat = async (messages) => { seen.push(messages); return replies.shift(); };

  const out = await extractTechniques(chat, { id: 'src_001', description: 'd', code: 'c' }, []);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'tech_staggered_char_reveal');
  assert.equal(out[1].id, 'tech_magnetic_button');
  // The retry fed the validation errors back to the model.
  assert.ok(JSON.stringify(seen.at(-1)).includes('greensock'));
});

test('extractTechniques throws after exhausting retries', async () => {
  const chat = async () => JSON.stringify({ techniques: [tech({ retrieval_probes: [] })] });
  await assert.rejects(() => extractTechniques(chat, { id: 'src_001', description: 'd', code: 'c' }, []),
    /retrieval_probes/);
});

test('registry accumulates techniques and component links across cards', () => {
  const reg = emptyRegistry();
  addToRegistry(reg, 'src_001', [{ ...tech(), id: 'tech_staggered_char_reveal' }]);
  addToRegistry(reg, 'src_002', [
    { ...tech(), id: 'tech_staggered_char_reveal', params: { stagger: [0.1, 0.2] } },
    { ...tech({ name: 'Magnetic button' }), id: 'tech_magnetic_button' },
  ]);

  assert.deepEqual(Object.keys(reg.techniques).sort(), ['tech_magnetic_button', 'tech_staggered_char_reveal']);
  assert.deepEqual(reg.techniques.tech_staggered_char_reveal.params.stagger, [0.02, 0.2]);
  assert.deepEqual(reg.techniques.tech_staggered_char_reveal.seen_in, ['src_001', 'src_002']);
  assert.deepEqual(reg.sources.src_002, ['tech_staggered_char_reveal', 'tech_magnetic_button']);

  assert.deepEqual(registryLinks(reg), [
    { component_id: 'src_001', technique_id: 'tech_staggered_char_reveal' },
    { component_id: 'src_002', technique_id: 'tech_staggered_char_reveal' },
    { component_id: 'src_002', technique_id: 'tech_magnetic_button' },
  ]);
  assert.deepEqual(knownNamesOf(reg), ['Staggered char reveal', 'Magnetic button']);
});

test('extractJson survives a fenced response with prose around it', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```\nhope that helps'), { a: 1 });
  assert.throws(() => extractJson('no object here'), /no JSON object/);
});
