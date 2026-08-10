import assert from 'node:assert';

delete process.env.NEXT_PUBLIC_ASSET_BASE;
const { assetUrl, proxiedAssetUrl } = await import('./assets.ts');

assert.equal(
  assetUrl('2026-08-05_DEMO PROJECT', 'CODE.zip'),
  'https://pub-2c8291ac249e456c8e906fe5f4aed9c9.r2.dev/2026-08-05_DEMO%20PROJECT/CODE.zip',
);

console.log('ok');

assert.equal(
  proxiedAssetUrl('2026-08-05_DEMO PROJECT', 'CODE.zip'),
  '/api/assets/2026-08-05_DEMO%20PROJECT/CODE.zip',
);
