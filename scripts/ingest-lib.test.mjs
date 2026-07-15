import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  encodePath, zipUrl, extOf, isTextFile, isJunkPath, langOf, safeRelPath,
  extractZip, humanBytes, partitionEntries, summarizeProject, aggregate, planDownloads,
} from './ingest-lib.mjs';

// --- tiny in-test ZIP writer (stored + deflate), so extractZip is verified
//     offline without downloading a real CODE.zip ------------------------------
function makeZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.data);
    const stored = f.method === 8 ? zlib.deflateRawSync(raw) : raw;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(f.method || 0, 8);
    lh.writeUInt32LE(0, 14);             // crc (ignored by extractZip)
    lh.writeUInt32LE(stored.length, 18); // compressed size
    lh.writeUInt32LE(raw.length, 22);    // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, stored);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(f.method || 0, 10);
    ch.writeUInt32LE(0, 16);
    ch.writeUInt32LE(stored.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + stored.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, eocd]);
}

test('encodePath encodes each segment, keeps slashes', () => {
  assert.equal(encodePath('a b/c,d'), 'a%20b/c%2Cd');
});

test('zipUrl mirrors lib/assets.ts (per-segment encode, trims trailing slash)', () => {
  assert.equal(
    zipUrl('https://x.r2.dev/', '2023-03-19_A NAV, MENU', 'CODE.zip'),
    'https://x.r2.dev/2023-03-19_A%20NAV%2C%20MENU/CODE.zip',
  );
});

test('extOf handles dot-files, extensionless, and multi-dot names', () => {
  assert.equal(extOf('src/app/page.tsx'), 'tsx');
  assert.equal(extOf('.gitignore'), 'gitignore');
  assert.equal(extOf('.env'), 'env');
  assert.equal(extOf('README'), 'readme');
  assert.equal(extOf('vendor/three.min.js'), 'js');
});

test('isTextFile / langOf classification', () => {
  assert.ok(isTextFile('a/style.scss'));
  assert.ok(isTextFile('main.tsx'));
  assert.ok(!isTextFile('img/hero.png'));
  assert.ok(!isTextFile('clip.mp4'));
  assert.equal(langOf('a.tsx'), 'TSX');
  assert.equal(langOf('a.glsl'), 'GLSL');
  assert.equal(langOf('a.bin'), 'Other');
});

test('isJunkPath flags macOS cruft and dependency/build dirs', () => {
  assert.ok(isJunkPath('__MACOSX/foo'));
  assert.ok(isJunkPath('a/.DS_Store'));
  assert.ok(isJunkPath('proj/node_modules/react/index.js'));
  assert.ok(isJunkPath('proj/.next/server/x.js'));
  assert.ok(!isJunkPath('src/index.js'));
});

test('safeRelPath rejects traversal and absolute paths', () => {
  assert.equal(safeRelPath('src/a.js'), 'src/a.js');
  assert.equal(safeRelPath('a\\b\\c.js'), 'a/b/c.js');
  assert.equal(safeRelPath('/etc/passwd'), 'etc/passwd');
  assert.equal(safeRelPath('../../etc/passwd'), null);
  assert.equal(safeRelPath('a/../../b'), null);
  assert.equal(safeRelPath('dir/'), null);
});

test('extractZip reads both stored and deflated entries, skips dir markers', () => {
  const zip = makeZip([
    { name: 'index.html', data: '<h1>hi</h1>', method: 0 },
    { name: 'src/app.js', data: 'console.log("x".repeat(50))', method: 8 },
    { name: 'node_modules/dep/big.js', data: 'x'.repeat(1000), method: 8 },
  ]);
  const entries = extractZip(zip);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.equal(byName['index.html'].data.toString('utf8'), '<h1>hi</h1>');
  assert.equal(byName['src/app.js'].data.toString('utf8'), 'console.log("x".repeat(50))');
  // extractZip returns everything; filtering is partitionEntries' job.
  assert.equal(byName['node_modules/dep/big.js'].size, 1000);
});

test('extractZip throws on a non-zip buffer', () => {
  assert.throws(() => extractZip(Buffer.from('not a zip at all')), /EOCD not found/);
});

test('partitionEntries splits kept text vs junk vs binary', () => {
  const { kept, skipped } = partitionEntries([
    { name: 'index.html', size: 10 },
    { name: 'style.css', size: 20 },
    { name: 'img/logo.png', size: 999 },
    { name: '__MACOSX/._x', size: 1 },
    { name: 'node_modules/x/y.js', size: 500 },
  ]);
  assert.deepEqual(kept.map((k) => k.name).sort(), ['index.html', 'style.css']);
  assert.equal(kept.find((k) => k.name === 'style.css').lang, 'CSS');
  assert.deepEqual(
    skipped.map((s) => s.reason).sort(),
    ['binary', 'junk', 'junk'],
  );
});

test('summarizeProject tallies files, bytes, and language histogram', () => {
  const kept = [
    { name: 'a.js', size: 100, lang: 'JavaScript' },
    { name: 'b.js', size: 50, lang: 'JavaScript' },
    { name: 'c.css', size: 30, lang: 'CSS' },
  ];
  assert.deepEqual(summarizeProject(kept), {
    fileCount: 3, textBytes: 180, byLang: { JavaScript: 2, CSS: 1 },
  });
});

test('aggregate rolls up projects and ignores failed ones', () => {
  const totals = aggregate([
    { status: 'ok', type: 'html', fileCount: 3, textBytes: 180, byLang: { JavaScript: 2, CSS: 1 } },
    { status: 'ok', type: 'react', fileCount: 2, textBytes: 90, byLang: { JavaScript: 1, JSON: 1 } },
    { status: 'error', type: 'html', fileCount: 0, textBytes: 0, byLang: {} },
  ]);
  assert.equal(totals.projects, 2);
  assert.equal(totals.files, 5);
  assert.equal(totals.textBytes, 270);
  assert.deepEqual(totals.byType, { html: 1, react: 1 });
  assert.deepEqual(totals.byLang, { JavaScript: 3, CSS: 1, JSON: 1 });
});

test('planDownloads builds R2 urls and carries expected zip size', () => {
  const index = {
    projects: [
      { id: 'p1', folder: '2023-03-19_NAV, MENU', type: 'html', zip: 'CODE.zip',
        media: { zips: [{ filename: 'CODE.zip', size: 1145558 }] } },
      { id: 'p2', folder: 'nozip', type: 'html', zip: null, media: { zips: [] } },
    ],
  };
  const plan = planDownloads(index, 'https://x.r2.dev');
  assert.equal(plan[0].url, 'https://x.r2.dev/2023-03-19_NAV%2C%20MENU/CODE.zip');
  assert.equal(plan[0].expectedZipBytes, 1145558);
  assert.equal(plan[1].url, null);
});

test('humanBytes formats across units', () => {
  assert.equal(humanBytes(512), '512 B');
  assert.equal(humanBytes(1536), '1.5 KB');
  assert.equal(humanBytes(3_757_291_006), '3.50 GB');
  assert.equal(humanBytes(null), '—');
});
