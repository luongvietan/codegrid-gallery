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

// Note `/` is NOT here: a component that wrote `/hero.jpg` meant "my folder",
// because it owned the document root. As a section it owns nothing, so a
// root-relative path is exactly as broken as a bare relative one.
const ABSOLUTE_URL = /^(https?:|data:|blob:|#|\/\/)/i;

/**
 * Re-point a component's relative asset URLs at where its files now live.
 *
 * The component's markup says `src="img/hero.jpg"`, which resolved against its
 * own folder. In the assembled page that path resolves against the output
 * directory instead, so every image 404s — the first build with images kept
 * still rendered a grid of broken-image icons. Real destinations (http, data,
 * protocol-relative) are left alone, as are urls a script builds at runtime:
 * `src="${imgSrc}"` cannot be resolved statically, and rewriting it would only
 * corrupt the template.
 */
export function rewriteAssetPaths(text, prefix) {
  const p = String(prefix).replace(/\/+$/, '');
  const fix = (url) => {
    const u = url.trim();
    if (ABSOLUTE_URL.test(u)) return url;
    if (u.includes('${') || u.includes('{{')) return url;   // built by JS at runtime
    return `${p}/${u.replace(/^\.?\//, '')}`;
  };
  return String(text ?? '')
    // html: src="...", href on images, poster="...", and every candidate in srcset
    .replace(/\b(src|poster)\s*=\s*(["'])([^"']+)\2/gi, (m, attr, q, url) => `${attr}=${q}${fix(url)}${q}`)
    .replace(/\bsrcset\s*=\s*(["'])([^"']+)\1/gi, (m, q, val) => {
      const out = val.split(',').map((part) => {
        const [url, ...rest] = part.trim().split(/\s+/);
        return [fix(url), ...rest].join(' ');
      }).join(', ');
      return `srcset=${q}${out}${q}`;
    })
    // css: url(...) with or without quotes
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, url) => `url(${q}${fix(url)}${q})`);
}

/**
 * Does this script need to be a module?
 *
 * Some of these pages ship ESM — `import gsap from "gsap"` at the top of
 * script.js. Wrapped in an IIFE and dropped into a plain <script> it throws
 * "Cannot use import statement outside a module" and the whole section is dead,
 * silently, because the rest of the page still renders.
 */
export function isEsModule(js) {
  return /^\s*(import\s[\s\S]*?from\s|import\s*[{'"(]|export\s)/m.test(String(js ?? ''));
}

/** The bare specifiers an ESM script imports, so they can join the import map. */
export function bareImportsOf(js) {
  const out = [];
  for (const m of String(js ?? '').matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g)) {
    const spec = m[1] || m[2];
    if (spec && !spec.startsWith('.') && !spec.startsWith('/') && !/^[a-z]+:/i.test(spec)) out.push(spec);
  }
  return [...new Set(out)];
}

/**
 * Run after every section's script.
 *
 * The composer has printed this instruction in every BUILD.md since the first
 * version — "call ScrollTrigger.refresh() after every section is in the DOM" —
 * and nothing ever did it. Each section registers triggers against positions that
 * later sections and loading images then move, so the triggers point at the wrong
 * offsets and their reveals never fire: 145 elements sat at opacity 0 on a page
 * that looked, correctly, broken.
 *
 * The fail-safe is deliberate too. An element still invisible seconds after load,
 * inside a section already on screen, is a bug and not an intention; the page
 * shows it rather than shipping a blank screen.
 */
export function bootstrapScript() {
  return `
(function () {
  function refresh() { if (window.ScrollTrigger) window.ScrollTrigger.refresh(); }
  window.addEventListener('load', refresh);
  document.querySelectorAll('img').forEach(function (i) {
    if (!i.complete) i.addEventListener('load', refresh, { once: true });
  });
  setTimeout(refresh, 800);

  // Nothing may stay invisible forever.
  setTimeout(function () {
    document.querySelectorAll('[data-slot] *').forEach(function (el) {
      var s = getComputedStyle(el), r = el.getBoundingClientRect();
      var offscreen = r.bottom < 0 || r.top > innerHeight * 2;
      if (offscreen || r.height < 4) return;
      // No regex here on purpose: escaping one through a template literal is how
      // this fail-safe shipped broken the first time, throwing before it ran.
      var clip = s.clipPath || '';
      var invisible = parseFloat(s.opacity) === 0
        || (clip.indexOf('inset(') === 0 && clip.indexOf('100%') !== -1);
      if (invisible) { el.style.opacity = '1'; el.style.clipPath = 'none'; el.style.visibility = 'visible'; }
    });
  }, 3500);
})();`;
}

/** Each component's script gets its own scope: two pages both declaring `const
 *  container` at top level would throw on the second one. */
export function wrapJs(js, slot) {
  return `/* ${slot} */\n(function () {\n${String(js ?? '').trim()}\n})();`;
}

/** A Google Fonts href for the families the direction chose. Without this the
 *  page falls back to a system sans and the type pairing is fiction — which is
 *  exactly what happened: a direction naming Space Grotesk rendered in Helvetica. */
export function fontHref(families = []) {
  const list = [...new Set(families.map((f) => String(f || '').split(',')[0].trim().replace(/["']/g, '')))]
    .filter((f) => f && !/^(ui-|system-ui|sans-serif|serif|monospace|-apple-system)/i.test(f));
  if (!list.length) return null;
  const spec = list.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@300;400;500;700;800`).join('&');
  return `https://fonts.googleapis.com/css2?${spec}&display=swap`;
}

export function buildPage({ title = 'Composed page', tokens = {}, externals = { css: [], js: [] }, sections = [], importMap = null, fonts = [] }) {
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
    ...(fontHref(fonts) ? [`<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`, `<link rel="stylesheet" href="${fontHref(fonts)}">`] : []),
    ...externals.css.map((h) => `<link rel="stylesheet" href="${h}">`),
    // The import map must precede any module script that uses it, and a document
    // gets exactly one — so every React section's dependencies are merged into it.
    ...(importMap && Object.keys(importMap.imports || {}).length
      ? [`<script type="importmap">
${JSON.stringify(importMap, null, 2)}
</script>`] : []),
    `<style>\n:root { ${rootVars} }\nhtml, body { margin: 0; padding: 0; background: ${colors.bg || '#fff'}; color: ${colors.fg || '#000'}; }\n/* position: the anchor that containFixed's absolutes resolve against.\n   overflow: without it those absolutes contribute no height, so a section's\n   content spills over the sections below it — a work list painted across the\n   contact and menu screens was how that showed up. */\n[data-slot] { position: relative; overflow: hidden; }
/* Layers sit above the page instead of lengthening it. Overlays start hidden —
   a menu that is always open is not a menu. */
[data-layer] { position: fixed; inset: 0; overflow: visible; }
[data-layer="global"] { pointer-events: none; z-index: 90; }
[data-layer="global"] a, [data-layer="global"] button { pointer-events: auto; }
[data-layer="overlay"] { z-index: 100; }
[data-slot][hidden] { display: none; }\n${sections.map((s) => s.css).filter(Boolean).join('\n')}\n</style>`,
  ].join('\n  ');

  // Scope decides where a section LIVES, not just how it is styled. A menu is an
  // overlay and a cursor is a layer; laid out in flow they become screens of
  // chrome pretending to be content — three of the eight screens on the first
  // art-directed page were a nav list, a preloader and a cursor demo.
  const inFlow = sections.filter((s) => (s.scope || 'section') === 'section');
  const layers = sections.filter((s) => (s.scope || 'section') !== 'section');
  const body = [
    ...inFlow.map((s) => `<section data-slot="${s.slot}">\n${s.html}\n</section>`),
    ...layers.map((s) => `<div data-slot="${s.slot}" data-layer="${s.scope}"${s.scope === 'overlay' ? ' hidden' : ''}>\n${s.html}\n</div>`),
  ].join('\n\n');
  const scripts = [
    // A CDN file that is itself an ES module must say so, or the browser parses
    // it as a classic script and throws on its first import.
    ...externals.js.map((s) => (/\.esm\.js(\?|$)|\/esm\//i.test(s)
      ? `<script type="module" src="${s}"></script>`
      : `<script src="${s}"></script>`)),
    sections.some((s) => s.js) ? `<script>\n${sections.filter((s) => s.js).map((s) => wrapJs(s.js, s.slot)).join('\n\n')}\n</script>` : '',
    // Bundled React sections get one module each, so a throw while mounting one
    // cannot stop the others — a single shared module would take the page down.
    ...sections.filter((s) => s.module).map((s) => `<script type="module">\n/* ${s.slot} */\n${s.module}\n</script>`),
    `<script>${bootstrapScript()}</script>`,
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
