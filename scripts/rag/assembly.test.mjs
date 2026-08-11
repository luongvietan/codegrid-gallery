import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBodyInner, extractExternals, dedupeExternals,
  scopeCss, rewriteTokens, wrapJs, buildPage, colorLiterals, containFixed, rewriteAssetPaths, isEsModule, bareImportsOf, fontHref,
} from './assembly.mjs';

// ---------- pulling a page apart ----------

test('extractBodyInner takes the body and drops hoisted external scripts', () => {
  const html = `<!doctype html><html><head><title>x</title></head>
    <body class="dark"><h1>Hi</h1>
    <script src="https://cdn/gsap.js"></script>
    <script>console.log('inline stays')</script>
    </body></html>`;
  const out = extractBodyInner(html);
  assert.ok(out.includes('<h1>Hi</h1>'));
  assert.ok(out.includes('inline stays'));
  assert.ok(!out.includes('cdn/gsap.js'));   // hoisted into one head instead
  assert.ok(!out.includes('<title>'));
});

test('extractBodyInner falls back to the whole fragment when there is no body', () => {
  assert.equal(extractBodyInner('<div>bare</div>'), '<div>bare</div>');
});

test('extractExternals takes CDN urls only, not local files', () => {
  const html = `<link rel="stylesheet" href="https://fonts.example/x.css">
    <link rel="stylesheet" href="styles.css">
    <script src="https://cdn.example/gsap.js"></script><script src="script.js"></script>`;
  const { css, js } = extractExternals(html);
  assert.deepEqual(css, ['https://fonts.example/x.css']);   // styles.css is inlined instead
  assert.deepEqual(js, ['https://cdn.example/gsap.js']);
});

test('dedupeExternals loads GSAP once however many components ask for it', () => {
  // Five components each pulling GSAP means five GSAPs, and the last one resets
  // the plugins the earlier ones registered.
  const out = dedupeExternals([
    ['https://cdn/gsap.js', 'https://cdn/st.js'],
    ['http://cdn/gsap.js', 'https://cdn/lenis.js'],
  ]);
  assert.deepEqual(out, ['https://cdn/gsap.js', 'https://cdn/st.js', 'https://cdn/lenis.js']);
});

// ---------- the part that actually prevents Frankenstein ----------

const S = '[data-slot="hero"]';

test('scopeCss re-points document-level selectors at the section', () => {
  // Every page in this corpus styles html/body/:root/*; five of them stacked
  // means the last stylesheet wins the whole document.
  assert.equal(scopeCss('body { background: #000; }', S), `${S}{ background: #000; }`);
  assert.equal(scopeCss('html { font-size: 10px; }', S), `${S}{ font-size: 10px; }`);
  assert.equal(scopeCss(':root { --x: 1px; }', S), `${S}{ --x: 1px; }`);
  assert.equal(scopeCss('* { margin: 0; }', S), `${S}, ${S} *{ margin: 0; }`);
  assert.equal(scopeCss('body .card { color: red; }', S), `${S} .card{ color: red; }`);
});

test('scopeCss nests ordinary selectors and keeps every selector in a list', () => {
  assert.equal(scopeCss('.a, .b > span { color: red; }', S), `${S} .a, ${S} .b > span{ color: red; }`);
});

test('scopeCss recurses into media queries but never touches keyframes', () => {
  const out = scopeCss('@media (max-width: 700px) { body { color: red; } }', S);
  assert.ok(out.includes('@media (max-width: 700px)'));
  assert.ok(out.includes(`${S}{ color: red; }`));

  // Scoping a keyframe step name would silently break every animation using it.
  const kf = scopeCss('@keyframes spin { from { rotate: 0deg; } to { rotate: 360deg; } }', S);
  assert.ok(kf.includes('@keyframes spin'));
  assert.ok(!kf.includes(S));
  assert.ok(scopeCss('@font-face { font-family: X; src: url(a.woff2); }', S).includes('@font-face'));
});

test('scopeCss survives comments and stray text', () => {
  assert.equal(scopeCss('/* note */ .a { color: red; }', S), `${S} .a{ color: red; }`);
  assert.doesNotThrow(() => scopeCss('.unclosed { color: red;', S));
});

// ---------- token rewrites ----------

test('rewriteTokens applies the composer maps without mangling neighbours', () => {
  const css = '.a { color: #111; background: #1111ff; font-family: Inter, sans-serif; }';
  const out = rewriteTokens(css, { colors: { '#111': '#000' }, fonts: { Inter: 'DM Sans' } });
  assert.ok(out.includes('color: #000'));
  assert.ok(out.includes('#1111ff'));        // a longer hex must not be half-rewritten
  assert.ok(out.includes('DM Sans'));

  // Interstate must survive a rule about Inter.
  assert.equal(rewriteTokens('font-family: Interstate;', { fonts: { Inter: 'DM Sans' } }), 'font-family: Interstate;');
});

test('colorLiterals lists every spelling of the same colour', () => {
  assert.deepEqual(colorLiterals('#fff').sort(), ['#fff', '#ffffff', 'white'].sort());
  assert.deepEqual(colorLiterals('white').sort(), ['#fff', '#ffffff', 'white'].sort());
  assert.deepEqual(colorLiterals('#0b1925'), ['#0b1925']);   // no shorthand, no name
  assert.deepEqual(colorLiterals('rgb(1,2,3)'), ['rgb(1,2,3)']);
});

test('rewriteTokens catches a colour written a different way', () => {
  // The real failure: the composer mapped #fff -> #000000, the section's CSS
  // said `#ffffff` and `white`, and the section stayed light on a dark page.
  const css = '.a { background: #ffffff; color: white; border-color: #fff; }';
  const out = rewriteTokens(css, { colors: { '#fff': '#000000' } });
  assert.ok(!/#ffffff|white|#fff\b/i.test(out), out);
  assert.equal((out.match(/#000000/g) || []).length, 3);
});

test('rewriteTokens snaps type sizes to the canonical scale', () => {
  const out = rewriteTokens('h1 { font-size: 15px; } p { font-size: 115px; }', { type_scale_px: { 15: 16 } });
  assert.ok(out.includes('font-size: 16px'));
  assert.ok(out.includes('115px'));          // 115 is not 15
});

test('containFixed pins a section fixed layer to its section', () => {
  // A nav that was fixed while its component owned the document floats over
  // every section below it once four components share the page.
  assert.equal(containFixed('.nav { position: fixed; top: 0; }'), '.nav { position: absolute; top: 0; }');
  assert.equal(containFixed('.a{position:FIXED}'), '.a{position: absolute}');
  assert.equal(containFixed('.b { position: sticky; }'), '.b { position: sticky; }');
});

test('rewriteAssetPaths re-points relative urls and leaves real ones alone', () => {
  // The component says src="img/hero.jpg" relative to ITS folder; in the
  // assembled page that resolves against the output dir and 404s.
  assert.equal(rewriteAssetPaths('<img src="img/hero.jpg">', 'assets/work'),
    '<img src="assets/work/img/hero.jpg">');
  assert.equal(rewriteAssetPaths('<img src="./a.png">', 'assets/work'), '<img src="assets/work/a.png">');
  assert.equal(rewriteAssetPaths('background: url(bg.jpg);', 'assets/work'), 'background: url(assets/work/bg.jpg);');
  assert.equal(rewriteAssetPaths("background: url('bg.jpg');", 'assets/work'), "background: url('assets/work/bg.jpg');");

  // A component that wrote `/hero.jpg` meant its own folder — it owned the
  // document root. As a section it owns nothing, so this needs rewriting too.
  assert.equal(rewriteAssetPaths('<img src="/hero.jpg">', 'assets/work'), '<img src="assets/work/hero.jpg">');

  for (const untouched of ['<img src="https://cdn/a.png">', '<img src="//cdn/a.png">',
    '<img src="data:image/png;base64,AA">', '<img src="${imgSrc}">']) {
    assert.equal(rewriteAssetPaths(untouched, 'assets/work'), untouched);
  }
  assert.equal(rewriteAssetPaths('<img srcset="a.png 1x, b.png 2x">', 'assets/w'),
    '<img srcset="assets/w/a.png 1x, assets/w/b.png 2x">');
});

// ---------- assembly ----------

test('wrapJs isolates each component so top-level names cannot collide', () => {
  const out = wrapJs('const container = 1;', 'hero');
  assert.match(out, /^\/\* hero \*\/\n\(function \(\) \{/);
  assert.ok(out.trim().endsWith('})();'));
});

test('buildPage emits one document with sections, scoped css and merged scripts', () => {
  const html = buildPage({
    title: 'Studio',
    tokens: { colors: { bg: '#0f0f0f', fg: '#fff', accent: '#f30' }, spacing_unit_px: 16 },
    externals: { css: ['https://fonts/x.css'], js: ['https://cdn/gsap.js'] },
    sections: [
      { slot: 'hero', html: '<h1>Hi</h1>', css: `${S}{ color: red; }`, js: 'console.log(1)' },
      { slot: 'work', html: '<ul></ul>', css: '', js: '' },
    ],
  });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<title>Studio</title>'));
  assert.ok(html.includes('--page-bg: #0f0f0f;'));
  assert.ok(html.includes('<link rel="stylesheet" href="https://fonts/x.css">'));
  assert.ok(html.includes('<section data-slot="hero">'));
  assert.ok(html.includes('<section data-slot="work">'));
  assert.ok(html.indexOf('data-slot="hero"') < html.indexOf('data-slot="work"'));  // slot order is page order
  assert.ok(html.includes('<script src="https://cdn/gsap.js"></script>'));
  assert.ok(html.includes('/* hero */'));
});

test('buildPage emits one import map before the module sections that need it', () => {
  const html = buildPage({
    sections: [
      { slot: 'hero', html: '<h1>Hi</h1>', css: '', js: 'console.log(1)' },
      { slot: 'work', html: '<div id="react-root-work"></div>', css: '', module: 'import React from "react";' },
    ],
    importMap: { imports: { react: 'https://esm.sh/react@19.2.0' } },
  });
  assert.ok(html.includes('<script type="importmap">'));
  assert.ok(html.includes('https://esm.sh/react@19.2.0'));
  // A module script resolves its bare specifiers against a map declared earlier.
  assert.ok(html.indexOf('importmap') < html.indexOf('type="module"'));
  assert.ok(html.includes('<script type="module">'));
  assert.ok(html.includes('/* hero */'));      // plain scripts still wrapped per section
});

test('buildPage omits the import map when nothing needs one', () => {
  const html = buildPage({ sections: [{ slot: 'hero', html: '<h1>Hi</h1>', css: '', js: '' }] });
  assert.ok(!html.includes('importmap'));
});

test('isEsModule spots a script that cannot be wrapped in an IIFE', () => {
  // Found in the browser, not the build: a vanilla page shipping ESM was dropped
  // into a plain <script>, threw "Cannot use import statement outside a module",
  // and its section was dead while the rest of the page rendered fine.
  assert.equal(isEsModule('import gsap from "gsap";\ngsap.to(x)'), true);
  assert.equal(isEsModule("import './style.css'"), true);
  assert.equal(isEsModule('export const a = 1'), true);
  assert.equal(isEsModule('const x = 1; el.addEventListener("click", fn)'), false);
  // A word that merely contains "import" is not an import.
  assert.equal(isEsModule('const important = 1'), false);
});

test('bareImportsOf collects only dependencies, for the import map', () => {
  const js = 'import gsap from "gsap";\nimport { x } from "./local.js";\nimport "lenis/dist/lenis.css";';
  assert.deepEqual(bareImportsOf(js), ['gsap', 'lenis/dist/lenis.css']);
});

test('fontHref asks for the families the direction chose, and skips system stacks', () => {
  // A direction naming Space Grotesk rendered in Helvetica because nothing ever
  // loaded it — the whole type pairing was fiction.
  const href = fontHref(['Space Grotesk', 'ui-sans-serif, system-ui, sans-serif']);
  assert.match(href, /^https:\/\/fonts\.googleapis\.com\/css2\?/);
  assert.match(href, /family=Space\+Grotesk/);
  assert.ok(!/system-ui/.test(href));             // a system stack needs no download
  assert.equal(fontHref(['system-ui', 'sans-serif']), null);
  assert.equal(fontHref([]), null);
});

test('buildPage keeps overlays and layers out of the page flow', () => {
  // Three of eight screens on the first art-directed page were a nav list, a
  // preloader and a cursor demo, stacked in flow as if they were content.
  const html = buildPage({
    sections: [
      { slot: 'hero', scope: 'section', html: '<h1>Hi</h1>', css: '' },
      { slot: 'cursor', scope: 'global', html: '<div class="dot"></div>', css: '' },
      { slot: 'menu', scope: 'overlay', html: '<nav>links</nav>', css: '' },
    ],
  });
  assert.ok(html.includes('<section data-slot="hero">'));
  assert.ok(html.includes('data-slot="cursor" data-layer="global"'));
  assert.ok(html.includes('data-slot="menu" data-layer="overlay"'));
  assert.match(html, /data-slot="menu"[^>]*hidden/);   // a menu that is always open is not a menu
  assert.ok(!html.includes('<section data-slot="menu"'));
  assert.ok(html.includes('[data-layer] { position: fixed'));
});

test('buildPage refreshes ScrollTrigger after assembly and never leaves a section blank', () => {
  // The composer printed this instruction in every BUILD.md and nothing did it:
  // sections register triggers against positions that later sections and loading
  // images then move, so 145 elements sat at opacity 0 on a page that looked,
  // correctly, broken.
  const html = buildPage({ sections: [{ slot: 'hero', scope: 'section', html: '<h1>x</h1>', css: '', js: 'gsap.from(".a",{})' }] });
  assert.match(html, /ScrollTrigger\.refresh\(\)/);
  assert.match(html, /addEventListener\('load'/);
  assert.match(html, /if \(!i\.complete\)/);         // and again once images land
  assert.match(html, /opacity = '1'/);               // the fail-safe
});
