import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NEXT_PUBLIC_ASSET_BASE = 'https://pub-x.r2.dev';
const { hasReadyPreview, previewKind, staticPreviewUrl } = await import('./preview.ts');

test('ready static manifest selects static preview without a ZIP', () => {
  const project = {
    type: 'react',
    preview: { mode: 'static', status: 'ready', sourceHash: 'sha256:abc', entry: 'index.html' },
  };

  assert.equal(previewKind(project), 'static');
  assert.equal(hasReadyPreview(project), true);
});

test('legacy HTML remains available', () => {
  assert.equal(previewKind({ type: 'html', entryHtml: 'demo/index.html' }), 'legacy-html');
});

test('static URL encodes hash and path segments', () => {
  assert.equal(
    staticPreviewUrl({ sourceHash: 'sha256:abc', entry: 'nested/index.html' }),
    'https://pub-x.r2.dev/previews/sha256%3Aabc/nested/index.html',
  );
});

test('incomplete static manifests fall back to the legacy HTML preview', () => {
  const project = {
    type: 'html',
    entryHtml: 'demo/index.html',
    preview: { mode: 'static', status: 'ready', sourceHash: 'sha256:abc', entry: null },
  };

  assert.equal(previewKind(project), 'legacy-html');
  assert.equal(hasReadyPreview(project), true);
  assert.throws(
    () => staticPreviewUrl(project.preview),
    /Static preview manifest is incomplete/,
  );
});
