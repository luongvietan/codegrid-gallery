// scripts/rag/assembly.mjs
// The step that writes code: turn a composition's decisions into one page.
//
// The hard part is not concatenation, it is that these are not components. Every
// entry in the corpus is a COMPLETE PAGE — its `dom_root` is `body` as often as
// it is a class — so assembling five of them means stacking five documents whose
// CSS all claims `*`, `html`, `body` and `:root`. Left alone the last stylesheet
// wins and the page is one component's design wearing four other components'
// markup.
//
// So each section is wrapped in its own element and its CSS is rewritten to live
// inside that element. Global selectors do not disappear; they are re-pointed at
// the section, which is the only honest reading of "this page's body" once the
// page is a section.
//
// Pure — no I/O, unit-tested offline.

/** Inner HTML of <body>, or the whole string when there is no body tag. */
export function extractBodyInner(html) {
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return (m ? m[1] : html)
    .replace(/<script[^>]*\ssrc\s*=\s*["'][^"']*["'][^>]*>\s*<\/script>/gi, '') // hoisted separately
    .trim();
}

/** External stylesheets and scripts to hoist into one head, in first-seen order. */
export function extractExternals(html) {
  const css = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)]
    .map((m) => /href=["']([^"']+)["']/i.exec(m[0])?.[1])
    .filter((h) => h && /^https?:\/\//i.test(h));
  const js = [...html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)]
    .map((m) => m[1])
    .filter((s) => /^https?:\/\//i.test(s));
  return { css, js };
}

/** One tag per URL, first occurrence wins — five components each pulling GSAP
 *  must not load five GSAPs, or the last one resets the others' plugins. */
export function dedupeExternals(lists) {
  const seen = new Set();
  const out = [];
  for (const url of lists.flat()) {
    const key = url.replace(/^https?:/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Selectors that mean "the document" — inside a section, the document is the
// section. Anything else is simply nested under it.
function scopeSelector(sel, scope) {
  const s = sel.trim();
  if (!s) return s;
  if (s.startsWith('@')) return s;
  if (/^(html|body|:root)$/i.test(s)) return scope;
  if (s === '*') return `${scope}, ${scope} *`;
  const lead = /^(html|body|:root)\b\s*/i.exec(s);
  if (lead) {
    const rest = s.slice(lead[0].length).trim();
    return rest ? `${scope} ${rest}` : scope;
  }
  return `${scope} ${s}`;
}

// At-rules whose contents are not selectors and must pass through untouched.
const PASSTHROUGH_AT = /^@(keyframes|-\w+-keyframes|font-face|import|charset|namespace|property|counter-style)/i;
// At-rules that wrap ordinary rules, so their body gets scoped recursively.
const NESTED_AT = /^@(media|supports|layer|container)/i;

/**
 * Rewrite a stylesheet so every rule applies only inside `scope`.
 * Hand-rolled rather than a CSS parser dependency, matching this repo's
 * zero-dependency rule; it walks braces and only ever touches selector text.
 */
export function scopeCss(css, scope) {
  const src = stripComments(String(css ?? ''));
  let out = '';
  let i = 0;
  while (i < src.length) {
    const brace = src.indexOf('{', i);
    if (brace === -1) { out += src.slice(i); break; }
    const prelude = src.slice(i, brace).trim();

    // find the matching close brace
    let depth = 1, j = brace + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    const body = src.slice(brace + 1, j - 1);

    if (PASSTHROUGH_AT.test(prelude)) {
      out += `${prelude}{${body}}\n`;
    } else if (NESTED_AT.test(prelude)) {
      out += `${prelude}{${scopeCss(body, scope)}}\n`;
    } else if (prelude) {
      const scoped = prelude.split(',').map((s) => scopeSelector(s, scope)).join(', ');
      out += `${scoped}{${body}}\n`;
    }
    i = j;
  }
  return out.trim();
}

/**
 * Apply the composer's `from -> to` maps. Word-boundary matching on purpose:
 * a naive replace of `#111` would also rewrite `#1111ff`, and of `Inter` would
 * rewrite `Interstate`.
 */
const NAMED = { white: '#ffffff', black: '#000000' };

/** Every literal that means the same colour. A rewrite map holding `#fff` must
 *  still catch `#ffffff` and `white`, or a section keeps the background the
 *  composer thought it had replaced — which is exactly how an assembled page
 *  ends up half dark and half light. */
export function colorLiterals(value) {
  const v = String(value).trim().toLowerCase();
  const hex = NAMED[v] || v;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(hex);
  if (!m) return [value];
  const long = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const short = long[0] === long[1] && long[2] === long[3] && long[4] === long[5]
    ? `#${long[0]}${long[2]}${long[4]}` : null;
  const named = Object.entries(NAMED).find(([, h]) => h === `#${long}`)?.[0];
  return [...new Set([`#${long}`, short, named].filter(Boolean))];
}

export function rewriteTokens(text, rewrite = {}) {
  let out = String(text ?? '');
  const pairs = [
    ...Object.entries(rewrite.colors || {}).flatMap(([from, to]) => colorLiterals(from).map((f) => [f, to])),
    ...Object.entries(rewrite.fonts || {}),
  ];
  for (const [from, to] of pairs) {
    if (!from || !to || from === to) continue;
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\w#-])${esc}(?![\\w-])`, 'gi'), to);
  }
  for (const [from, to] of Object.entries(rewrite.type_scale_px || {})) {
    if (String(from) === String(to)) continue;
    out = out.replace(new RegExp(`(?<![\\d.])${from}px\\b`, 'g'), `${to}px`);
  }
  return out;
}

/**
 * Pin a section's fixed elements to the section.
 *
 * `position: fixed` is measured against the viewport, not the wrapper, so a nav
 * that was fixed when its component owned the whole document floats over every
 * section below it once four components share the page — and the fixed layers of
 * four different designs pile up in the same corner. Inside a section wrapper
 * (which buildPage gives `position: relative`), `absolute` means what `fixed`
 * meant when the component was alone.
 *
 * Global-scope components are exempt: a cursor that stops following the viewport
 * is not a cursor.
 */
export function containFixed(css) {
  return String(css ?? '').replace(/position\s*:\s*fixed/gi, 'position: absolute');
}

/** Each component's script gets its own scope: two pages both declaring `const
 *  container` at top level would throw on the second one. */
export function wrapJs(js, slot) {
  return `/* ${slot} */\n(function () {\n${String(js ?? '').trim()}\n})();`;
}

export function buildPage({ title = 'Composed page', tokens = {}, externals = { css: [], js: [] }, sections = [] }) {
  const colors = tokens.colors || {};
  const rootVars = [
    colors.bg && `--page-bg: ${colors.bg};`,
    colors.fg && `--page-fg: ${colors.fg};`,
    colors.accent && `--page-accent: ${colors.accent};`,
    tokens.spacing_unit_px && `--page-space: ${tokens.spacing_unit_px}px;`,
  ].filter(Boolean).join(' ');

  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    ...externals.css.map((h) => `<link rel="stylesheet" href="${h}">`),
    `<style>\n:root { ${rootVars} }\nhtml, body { margin: 0; padding: 0; background: ${colors.bg || '#fff'}; color: ${colors.fg || '#000'}; }\n[data-slot] { position: relative; }\n${sections.map((s) => s.css).filter(Boolean).join('\n')}\n</style>`,
  ].join('\n  ');

  const body = sections.map((s) => `<section data-slot="${s.slot}">\n${s.html}\n</section>`).join('\n\n');
  const scripts = [
    ...externals.js.map((s) => `<script src="${s}"></script>`),
    sections.some((s) => s.js) ? `<script>\n${sections.filter((s) => s.js).map((s) => wrapJs(s.js, s.slot)).join('\n\n')}\n</script>` : '',
  ].filter(Boolean).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  ${head}
</head>
<body>
${body}

${scripts}
</body>
</html>
`;
}
