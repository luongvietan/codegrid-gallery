import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBodyInner, extractExternals, dedupeExternals,
  scopeCss, rewriteTokens, wrapJs, buildPage, colorLiterals, containFixed,
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
