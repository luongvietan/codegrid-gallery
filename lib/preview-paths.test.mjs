import test from 'node:test';
import assert from 'node:assert/strict';

test('aliases files beside a nested HTML entry to preview-root paths', async () => {
  const { previewRootAliases } = await import('./preview-paths.ts');
  const aliases = previewRootAliases([
    'demo/index.html',
    'demo/styles.css',
    'demo/script.js',
    'demo/assets/hero.jpg',
    'other/readme.txt',
  ], 'demo/index.html');

  assert.deepEqual(aliases, [
    ['index.html', 'demo/index.html'],
    ['styles.css', 'demo/styles.css'],
    ['script.js', 'demo/script.js'],
    ['assets/hero.jpg', 'demo/assets/hero.jpg'],
  ]);
});

test('does not create redundant aliases when the entry is at zip root', async () => {
  const { previewRootAliases } = await import('./preview-paths.ts');
  assert.deepEqual(previewRootAliases(['index.html', 'styles.css'], 'index.html'), []);
});

test('serves a public/ directory from the site root, as Vite and CRA do', async () => {
  const { previewRootAliases } = await import('./preview-paths.ts');
  const aliases = new Map(previewRootAliases([
    'demo/index.html',
    'demo/public/img1.jpg',
    'demo/public/media/clip.mp4',
  ], 'demo/index.html'));

  assert.equal(aliases.get('img1.jpg'), 'demo/public/img1.jpg');
  assert.equal(aliases.get('media/clip.mp4'), 'demo/public/media/clip.mp4');
  assert.equal(aliases.get('public/img1.jpg'), 'demo/public/img1.jpg', 'the literal path still resolves');
});

test('aliases public/ even when the entry sits at zip root', async () => {
  const { previewRootAliases } = await import('./preview-paths.ts');
  assert.deepEqual(previewRootAliases(['index.html', 'public/img1.jpg'], 'index.html'), [
    ['img1.jpg', 'public/img1.jpg'],
  ]);
});

test('a real file beside the entry outranks its namesake in public/', async () => {
  const { previewRootAliases } = await import('./preview-paths.ts');
  const aliases = new Map(previewRootAliases([
    'demo/index.html',
    'demo/logo.svg',
    'demo/public/logo.svg',
  ], 'demo/index.html'));

  assert.equal(aliases.get('logo.svg'), 'demo/logo.svg');
});
