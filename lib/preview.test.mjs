import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NEXT_PUBLIC_ASSET_BASE = 'https://pub-x.r2.dev';
const { hasPreviewTab, hasReadyPreview, needsSourceZip, previewKind, staticPreviewUrl } = await import('./preview.ts');

test('ZIP is not required for a static preview or media tab', () => {
  assert.equal(needsSourceZip('preview', 'static'), false);
  assert.equal(needsSourceZip('media', 'static'), false);
  assert.equal(needsSourceZip('code', 'static'), true);
  assert.equal(needsSourceZip('preview', 'legacy-html'), true);
});

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

test('React source with an HTML entry uses the ZIP preview like an HTML template', () => {
  const project = { type: 'react', entryHtml: 'demo/index.html' };

  assert.equal(previewKind(project), 'legacy-html');
  assert.equal(hasPreviewTab(project), true);
  assert.equal(needsSourceZip('preview', previewKind(project)), true);
});

test('Next.js runtime previews load their source ZIP while media stays ZIP-free', () => {
  const project = { type: 'nextjs', entryHtml: null };

  assert.equal(previewKind(project), 'runtime-required');
  assert.equal(hasPreviewTab(project), true);
  assert.equal(hasReadyPreview(project), false);
  assert.equal(needsSourceZip('preview', previewKind(project)), true);
  assert.equal(needsSourceZip('media', previewKind(project)), false);
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
