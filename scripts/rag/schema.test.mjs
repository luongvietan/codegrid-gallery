import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENUMS, validateCard, embeddingText, LLM_FIELDS } from './schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(HERE, '../../supabase/migrations/0001_codegrid_rag.sql');

// A minimal valid card (every required field present, enums clean).
function baseCard(over = {}) {
  return {
    scope: 'section', comp_type: 'hero', framework: 'vanilla',
    animation_libs: ['gsap', 'splittext'], css_approach: 'vanilla_css',
    needs_webgl: false, asset_types: ['font'], side_effects: ['scrolltrigger_register'],
    aesthetic: ['editorial'], motion_character: ['scroll_driven'],
    density: 'sparse', color_mood: 'dark',
    description: 'A full-viewport hero with oversized type that reveals per character.',
    retrieval_probes: ['big type hero reveal on load', 'editorial dark hero kinetic type', 'full-bleed headline parallax'],
    dom_root: '.hero', entry_point: 'initHero()',
    design_tokens: { colors: { bg: '#0A0A0A' } }, content_slots: { text: [] },
    responsive: 'fluid', coupling: 'needs_scroll_container', notes: null,
    ...over,
  };
}

test('validateCard accepts a clean card', () => {
  const { ok, errors } = validateCard(baseCard());
  assert.equal(ok, true, errors.join('; '));
});

test('validateCard rejects an off-enum value (principle #1)', () => {
  const { ok, errors } = validateCard(baseCard({ comp_type: 'splash_screen' }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('comp_type')));
});

test('validateCard rejects an off-enum array element', () => {
  const { ok, errors } = validateCard(baseCard({ animation_libs: ['gsap', 'greensock'] }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('greensock')));
});

test('validateCard flags a scope/comp_type mismatch (cursor is not a section)', () => {
  const { ok, errors } = validateCard(baseCard({ scope: 'section', comp_type: 'cursor' }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('does not belong to scope')));
});

test('validateCard requires 3–5 retrieval probes', () => {
  assert.equal(validateCard(baseCard({ retrieval_probes: ['only one'] })).ok, false);
  assert.equal(validateCard(baseCard({ retrieval_probes: ['a', 'b', 'c', 'd', 'e', 'f'] })).ok, false);
});

test('validateCard flags missing required fields and empty description', () => {
  const c = baseCard();
  delete c.scope;
  c.description = '   ';
  const { ok, errors } = validateCard(c);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.startsWith('scope')));
  assert.ok(errors.some((e) => e.startsWith('description')));
});

test('nullable soft fields may be null', () => {
  assert.equal(validateCard(baseCard({ density: null, color_mood: null, css_approach: null })).ok, true);
});

test('embeddingText concatenates description + probes (query-space match)', () => {
  const t = embeddingText(baseCard());
  assert.ok(t.includes('oversized type'));
  assert.ok(t.includes('editorial dark hero'));
});

test('LLM_FIELDS covers exactly the annotator output fields', () => {
  assert.ok(LLM_FIELDS.includes('description') && LLM_FIELDS.includes('side_effects'));
  assert.ok(!LLM_FIELDS.includes('id')); // id/code/embedding are pipeline-attached, not LLM
});

// The single guard that keeps SQL enums and JS enums from drifting.
test('SQL migration enums exactly match ENUMS in schema.mjs', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const sqlToJs = {
    comp_scope: 'scope', comp_type: 'comp_type', framework_type: 'framework',
    anim_lib: 'anim_lib', css_approach_type: 'css_approach', asset_type: 'asset_type',
    side_effect: 'side_effect', aesthetic_tag: 'aesthetic', motion_tag: 'motion_tag',
    density_type: 'density', color_mood: 'color_mood', responsive_type: 'responsive',
    coupling_type: 'coupling',
  };
  const re = /create type (\w+)\s+as enum\s*\(([\s\S]*?)\)/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(sql)) !== null) {
    const [, sqlName, body] = m;
    const jsKey = sqlToJs[sqlName];
    assert.ok(jsKey, `SQL enum ${sqlName} has no JS mapping`);
    const values = [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]);
    assert.deepEqual(values, ENUMS[jsKey], `enum ${sqlName} drifted from ENUMS.${jsKey}`);
    seen.add(jsKey);
  }
  for (const jsKey of Object.values(sqlToJs)) {
    assert.ok(seen.has(jsKey), `ENUMS.${jsKey} has no matching SQL enum`);
  }
});
