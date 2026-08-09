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
