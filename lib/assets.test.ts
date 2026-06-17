import assert from 'node:assert';
process.env.NEXT_PUBLIC_ASSET_BASE = 'https://pub-x.r2.dev/';
const { assetUrl } = await import('./assets.ts');

assert.equal(assetUrl('folderA', 'CODE.zip'), 'https://pub-x.r2.dev/folderA/CODE.zip');
assert.equal(assetUrl('2023_FOO BAR', 'CG 1.jpg'), 'https://pub-x.r2.dev/2023_FOO%20BAR/CG%201.jpg');
assert.equal(assetUrl('a/b', 'x.png'), 'https://pub-x.r2.dev/a/b/x.png'); // slash preserved
console.log('ok');
