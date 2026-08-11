// scripts/rag/generation.mjs
// Write a section instead of transplanting one.
//
// Five rounds of assemble → critique showed the ceiling of reuse: once the
// structural faults are fixed, what the critique still sees is three brands, three
// type hierarchies and three ideas of a header on one page — because it is three
// finished designs stapled together. Scoping CSS makes a page structurally
// coherent; it cannot make it one design.
//
// So for a slot the index cannot fill, we do not force a component in. We hand the
// model the page's own tokens, the slot's intent, and the TECHNIQUES mined from
// the corpus (mechanism, parameter ranges, and real code from the components that
// exhibit them) and ask for fresh markup written in the page's design language.
// The corpus supplies the how; the page supplies the look.
//
// Pure — the LLM arrives as an injected `chat`, so this is unit-tested offline.
import { extractJson } from './llm.mjs';

export const SECTION_FIELDS = ['html', 'css', 'js', 'notes'];

const MAX_EXCERPT = 1800;

export function buildSectionPrompt({ slot, tokens = {}, techniques = [], excerpts = {}, direction = '', images = [], fontFamilies = [] }) {
  const t = tokens.colors || {};
  const fonts = (tokens.fonts || []).map((f) => `${f.family}${f.role ? ` (${f.role})` : ''}`).join(', ') || 'unspecified';
  const scale = (tokens.type_scale_px || []).join(', ') || 'unspecified';

  const tech = techniques.map((x, i) => {
    const src = excerpts[x.id] ? `\nREAL CODE that does this, for syntax only — do not copy its markup or its content:\n${String(excerpts[x.id]).slice(0, MAX_EXCERPT)}` : '';
    return `${i + 1}. ${x.name || x.id} — ${x.mechanism}\n   parameters seen in the corpus: ${JSON.stringify(x.params || {})}${src}`;
  }).join('\n\n');

  const art = direction ? `
ART DIRECTION — the page was directed before any section was written. Obey it; it is not a suggestion:
${direction}
` : '';
  const pics = images.length
    ? `
REAL IMAGES available to this page. Use them with <img src="..."> — they exist on disk. Do NOT invent other paths:
${images.map((i) => `- ${i}`).join('\n')}
`
    : '';

  return `Write ONE section of a web page. Return ONLY one JSON object with keys: ${SECTION_FIELDS.join(', ')}.${art}${pics}

SECTION: ${slot.key} (${slot.comp_type})
WHAT IT SHOULD BE: ${slot.intent}

THE PAGE'S DESIGN SYSTEM — this section must look like it belongs to it, not like a component borrowed from somewhere else:
- background ${t.bg || 'unspecified'}, foreground ${t.fg || 'unspecified'}, accent ${t.accent || 'unspecified'}
- fonts: ${fonts}
- type scale (px): ${scale}
- spacing unit: ${tokens.spacing_unit_px ?? 'unspecified'}px${tokens.max_width_px ? `, max width ${tokens.max_width_px}px` : ''}

TECHNIQUES from the archive — use these mechanisms rather than inventing motion:
${tech || '(none retrieved — write something simple and static)'}

RULES:
1. "html": the section's inner markup only. NO <html>, <head>, <body> or <section> wrapper — it is inserted into one. No <style> or <script> tags.
2. "css": plain CSS for this section only. Every selector must be a class or element INSIDE the section. Never style html, body or :root — the section does not own the document.
3. "js": plain JavaScript, or "" if the section needs none. It runs after the DOM exists, wrapped in its own scope. Use only what the techniques above show; if a technique needs GSAP, assume \`gsap\` is already on the page — do NOT add a script tag or an import.
4. Use the page's colours, fonts and spacing above. Do NOT name any font-family the direction did not choose — an invented family falls back to the system sans and the page's typography stops existing.
4b. HEIGHT BUDGET, from this section's rhythm entry: "full" means one viewport (100vh / min-height:100svh); "tall" means two to three viewports of REAL CONTENT, not padding; "auto" is the content's own height. Do not pad to fill and do not starve: a "tall" section with one headline and two images is as wrong as one three times its budget. If images are listed above, a dense section should use several of them.
5. Real, plausible copy — this is a portfolio-grade page, not lorem ipsum. Keep headlines short enough not to wrap awkwardly. A section carrying the page needs enough substance to earn its height: several items, captions, an index — not one line and a lot of air.
6. No external URLs and no CDN links. For imagery use the real files listed above; only if none are listed may you draw a placeholder with CSS or inline SVG.
7. "notes": one line on what you built and which technique you used.`;
}

// A generated section that styles the document, or drags in a CDN, defeats the
// point: the page would be back to fighting over globals.
const GENERIC_FAMILIES = /^(inherit|initial|unset|serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|-apple-system|blinkmacsystemfont|segoe ui|roboto|helvetica neue|helvetica|arial|emoji|math|fangsong)$/i;

export function validateSection(section, slotKey, allowedFonts = []) {
  const errors = [];
  if (section == null || typeof section !== 'object' || Array.isArray(section)) {
    return { ok: false, errors: ['section is not an object'] };
  }
  if (typeof section.html !== 'string' || !section.html.trim()) errors.push('html: must be a non-empty string');
  if (typeof section.css !== 'string') errors.push('css: must be a string (use "" for none)');
  if (typeof section.js !== 'string') errors.push('js: must be a string (use "" for none)');

  const html = String(section.html ?? '');
  if (/<\/?(html|head|body)\b/i.test(html)) errors.push('html: must not contain <html>, <head> or <body> — it is inserted into a section');
  if (/<style\b/i.test(html)) errors.push('html: must not contain <style> — put it in "css"');
  if (/<script\b/i.test(html)) errors.push('html: must not contain <script> — put it in "js"');
  if (/<link\b/i.test(html)) errors.push('html: must not contain <link> — no external resources');

  const css = String(section.css ?? '');
  // Every prelude, then every selector in it: `html, .a { }` hides a document
  // selector behind a harmless one, and a comma-split is the only way to see it.
  for (const m of css.matchAll(/([^{}]+)\{/g)) {
    const prelude = m[1].trim();
    if (prelude.startsWith('@')) continue;               // at-rule, not a selector list
    for (const sel of prelude.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (/^(html|body|:root)\b/i.test(sel)) {
        errors.push(`css: selector "${sel}" styles the document — the section does not own html/body/:root`);
      }
    }
  }
  if (/@import/i.test(css)) errors.push('css: @import is not allowed — no external resources');
  if (/url\(\s*["']?https?:/i.test(css)) errors.push('css: remote url() is not allowed — draw placeholders with CSS or inline SVG');
  if (/https?:\/\//i.test(html)) errors.push('html: remote URLs are not allowed');
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    if (!/^assets\//.test(m[1])) errors.push(`html: <img src="${m[1]}"> — only the listed assets/ files exist`);
  }
  // Static `import x from "y"` as well as dynamic import(): a generated section
  // runs inside a plain <script>, so a static import throws "Cannot use import
  // statement outside a module" and kills that section while the page renders on.
  const sectionJs = String(section.js ?? '');
  if (/\b(import|require)\s*\(/.test(sectionJs)
    || /^\s*import\s+[\s\S]*?from\s/m.test(sectionJs)
    || /^\s*import\s*["']/m.test(sectionJs)
    || /^\s*export\s/m.test(sectionJs)) {
    errors.push('js: no import or export — the section runs in a plain script and the libraries it needs are already on the page');
  }

  // Fonts, enforced rather than asked for. A section that names a family the
  // direction never chose gets the system fallback, and the page's typography
  // quietly stops existing — which is exactly what happened with the prompt rule
  // alone: a hero asked for "Monument Extended" and rendered in Helvetica.
  if (allowedFonts.length) {
    const allowed = new Set(allowedFonts.flatMap((f) => String(f).split(',')).map((f) => f.trim().replace(/["']/g, '').toLowerCase()));
    for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
      for (const fam of m[1].split(',').map((f) => f.trim().replace(/["']/g, ''))) {
        if (!fam || GENERIC_FAMILIES.test(fam) || allowed.has(fam.toLowerCase()) || fam.startsWith('var(')) continue;
        errors.push(`css: font-family "${fam}" is not one the direction chose (${allowedFonts.join(', ')}) — it would fall back to the system sans`);
      }
    }
  }

  if (slotKey && errors.length === 0 && !html.trim()) errors.push(`html: nothing generated for slot "${slotKey}"`);
  return { ok: errors.length === 0, errors };
}

/** Ask for one section, validating with the same retry-with-errors loop as the
 *  rest of the pipeline. */
export async function generateSection(chat, spec, attempts = 3) {
  const messages = [{ role: 'user', content: buildSectionPrompt(spec) }];
  let lastErr = 'unknown';
  for (let i = 0; i < attempts; i++) {
    const text = await chat(messages, 16000);
    let section;
    try { section = extractJson(text); } catch (e) {
      lastErr = e.message;
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `That was not valid JSON (${e.message}). Return ONLY the JSON object.` });
      continue;
    }
    const { ok, errors } = validateSection(section, spec.slot?.key, spec.fontFamilies || []);
    if (ok) return { html: section.html, css: section.css || '', js: section.js || '', notes: section.notes || '' };
    lastErr = errors.join('; ');
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Fix ONLY these and return the full corrected JSON:\n- ${errors.join('\n- ')}` });
  }
  throw new Error(`section generation failed after retries: ${lastErr}`);
}
