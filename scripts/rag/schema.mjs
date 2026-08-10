// scripts/rag/schema.mjs
// Card Schema v1 — the single source of truth for the annotation layer.
// Enums live here (JS), the SQL migration mirrors them, and a test asserts the
// two never drift (schema.test.mjs). No I/O — pure + unit-tested.
//
// Design principles (from the schema spec):
//   1. Hard fields = enum, never free text  -> enforced by validateCard, not by prompt.
//   2. Hard fields drive WHERE; soft fields + description drive the embedding.
//   3. description describes the OUTPUT (what you see), never the code.

export const ENUMS = {
  scope: ['section', 'global', 'overlay'],
  comp_type: [
    // section
    'nav', 'hero', 'about', 'work_grid', 'project_detail', 'gallery',
    'marquee', 'testimonial', 'pricing', 'faq', 'cta', 'contact',
    'footer', 'text_block', 'stats', 'team', 'process',
    // global
    'cursor', 'smooth_scroll', 'preloader', 'scroll_progress', 'audio_toggle',
    // overlay
    'menu', 'modal', 'lightbox', 'page_transition',
  ],
  framework: ['vanilla', 'react', 'next', 'vue', 'svelte'],
  anim_lib: [
    'gsap', 'scrolltrigger', 'scrollsmoother', 'splittext', 'flip',
    'framer_motion', 'motion_one', 'anime',
    'lenis', 'locomotive',
    'three', 'ogl', 'curtains', 'pixi',
    'matter', 'cannon',
    'swiper', 'embla',
    'none',
  ],
  css_approach: ['vanilla_css', 'tailwind', 'scss', 'css_modules', 'styled_components'],
  asset_type: ['image', 'video', 'font', 'model_3d', 'audio'],
  side_effect: [
    'body_overflow_lock', 'scroll_hijack', 'scrolltrigger_register', 'own_raf_loop',
    'resize_listener', 'wheel_listener', 'pointer_listener_global', 'fixed_layer',
    'history_api', 'canvas_fullscreen',
  ],
  aesthetic: [
    'brutalist', 'editorial', 'minimal', 'maximalist', 'swiss',
    'retro', 'organic', 'tech', 'luxury', 'playful', 'experimental',
  ],
  motion_tag: [
    'scroll_driven', 'hover_driven', 'click_driven',
    'autoplay', 'physics', 'cursor_follow', 'static',
  ],
  density: ['sparse', 'balanced', 'dense'],
  color_mood: ['dark', 'light', 'high_contrast', 'muted', 'vivid'],
  responsive: ['fluid', 'breakpoints', 'fixed', 'unknown'],
  coupling: ['standalone', 'needs_siblings', 'needs_scroll_container'],
};

// Which comp_type values belong to which scope — lets the annotator (and the
// planner) catch "cursor placed as a section" mistakes.
export const SCOPE_OF_COMP_TYPE = {
  section: ['nav', 'hero', 'about', 'work_grid', 'project_detail', 'gallery', 'marquee',
    'testimonial', 'pricing', 'faq', 'cta', 'contact', 'footer', 'text_block', 'stats', 'team', 'process'],
  global: ['cursor', 'smooth_scroll', 'preloader', 'scroll_progress', 'audio_toggle'],
  overlay: ['menu', 'modal', 'lightbox', 'page_transition'],
};

// Field spec that drives validateCard. kind: 'enum' | 'enum[]' | 'str' | 'str[]'
// | 'bool' | 'obj'. required: must be present & non-null. Nullable fields may be null.
const FIELD_SPEC = {
  scope: { kind: 'enum', enum: 'scope', required: true },
  comp_type: { kind: 'enum', enum: 'comp_type', required: true },
  framework: { kind: 'enum', enum: 'framework', required: true },
  animation_libs: { kind: 'enum[]', enum: 'anim_lib', required: true },
  css_approach: { kind: 'enum', enum: 'css_approach', required: false },
  needs_webgl: { kind: 'bool', required: true },
  asset_types: { kind: 'enum[]', enum: 'asset_type', required: true },
  side_effects: { kind: 'enum[]', enum: 'side_effect', required: true },
  aesthetic: { kind: 'enum[]', enum: 'aesthetic', required: true },
  motion_character: { kind: 'enum[]', enum: 'motion_tag', required: true },
  density: { kind: 'enum', enum: 'density', required: false },
  color_mood: { kind: 'enum', enum: 'color_mood', required: false },
  description: { kind: 'str', required: true },
  retrieval_probes: { kind: 'str[]', required: true },
  dom_root: { kind: 'str', required: false },
  entry_point: { kind: 'str', required: false },
  design_tokens: { kind: 'obj', required: true },
  content_slots: { kind: 'obj', required: true },
  responsive: { kind: 'enum', enum: 'responsive', required: false },
  coupling: { kind: 'enum', enum: 'coupling', required: false },
  notes: { kind: 'str', required: false },
};

// The exact set of fields the annotator LLM must return (DB adds id/source_path/
// loc/code/origin_site/embedding/schema_version/annotator_model).
export const LLM_FIELDS = Object.keys(FIELD_SPEC);

/**
 * Validate a raw annotator card. Returns { ok, errors } — errors is a list of
 * human-readable strings suitable for feeding back to the model on retry.
 * This is the enforcement point for "hard fields = enum" (principle #1).
 */
export function validateCard(card) {
  const errors = [];
  if (card == null || typeof card !== 'object' || Array.isArray(card)) {
    return { ok: false, errors: ['card is not an object'] };
  }
  for (const [field, spec] of Object.entries(FIELD_SPEC)) {
    const v = card[field];
    const present = v !== undefined && v !== null;
    if (!present) {
      if (spec.required) errors.push(`${field}: required but missing/null`);
      continue;
    }
    const set = spec.enum ? new Set(ENUMS[spec.enum]) : null;
    switch (spec.kind) {
      case 'enum':
        if (!set.has(v)) errors.push(`${field}: "${v}" not in enum ${spec.enum}`);
        break;
      case 'enum[]':
        if (!Array.isArray(v)) { errors.push(`${field}: must be an array`); break; }
        for (const x of v) if (!set.has(x)) errors.push(`${field}: "${x}" not in enum ${spec.enum}`);
        break;
      case 'str':
        if (typeof v !== 'string' || !v.trim()) errors.push(`${field}: must be a non-empty string`);
        break;
      case 'str[]':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) errors.push(`${field}: must be a string array`);
        break;
      case 'bool':
        if (typeof v !== 'boolean') errors.push(`${field}: must be a boolean`);
        break;
      case 'obj':
        if (typeof v !== 'object' || Array.isArray(v)) errors.push(`${field}: must be an object`);
        break;
      default:
        break;
    }
  }
  // Cross-field: comp_type must live under scope (catches "cursor as section").
  if (card.scope && card.comp_type && ENUMS.scope.includes(card.scope)) {
    const allowed = SCOPE_OF_COMP_TYPE[card.scope] || [];
    if (ENUMS.comp_type.includes(card.comp_type) && !allowed.includes(card.comp_type)) {
      errors.push(`comp_type "${card.comp_type}" does not belong to scope "${card.scope}"`);
    }
  }
  // retrieval_probes: 3–5, the recall lever — enforce the count.
  if (Array.isArray(card.retrieval_probes)) {
    const n = card.retrieval_probes.filter((p) => typeof p === 'string' && p.trim()).length;
    if (n < 3 || n > 5) errors.push(`retrieval_probes: expected 3–5 non-empty probes, got ${n}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Text that gets embedded for the component index: description + probes (query-space match). */
export function embeddingText(card) {
  const probes = Array.isArray(card.retrieval_probes) ? card.retrieval_probes.join('\n') : '';
  return `${card.description || ''}\n${probes}`.trim();
}
