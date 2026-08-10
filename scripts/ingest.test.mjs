import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeProject, writeCorpus } from './ingest.mjs';

// Minimal STORED-method zip writer (deflate path is covered in ingest-lib.test.mjs).
function makeZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
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

test('ingest pipeline: extract → write source → manifest + docs (offline)', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
  try {
    const htmlZip = makeZip([
      { name: 'index.html', data: '<h1>Hello</h1>' },
      { name: 'css/style.css', data: 'body{margin:0}' },
      { name: 'assets/hero.png', data: 'PNGDATA' },       // binary → skipped
      { name: '__MACOSX/._index.html', data: 'junk' },    // junk → skipped
    ]);
    const reactZip = makeZip([
      { name: 'src/App.jsx', data: 'export default () => <div/>' },
      { name: 'package.json', data: '{"name":"demo"}' },
      { name: 'node_modules/react/index.js', data: 'module.exports={}' }, // dep → skipped
    ]);

    const r1 = writeProject(htmlZip, { id: 'p_html', folder: 'F1', title: 'HTML demo', type: 'html', entryHtml: 'index.html', expectedZipBytes: 1 }, out);
    const r2 = writeProject(reactZip, { id: 'p_react', folder: 'F2', title: 'React demo', type: 'react', entryHtml: null }, out);

    // Source files landed on disk; junk/binary/deps did not.
    assert.equal(fs.readFileSync(path.join(out, 'p_html', 'index.html'), 'utf8'), '<h1>Hello</h1>');
    assert.equal(fs.readFileSync(path.join(out, 'p_html', 'css', 'style.css'), 'utf8'), 'body{margin:0}');
    assert.ok(!fs.existsSync(path.join(out, 'p_html', 'assets', 'hero.png')));
    assert.ok(!fs.existsSync(path.join(out, 'p_react', 'node_modules')));

    assert.equal(r1.fileCount, 2);
    assert.equal(r1.skippedBinary, 2);           // png + __MACOSX
    assert.deepEqual(r1.byLang, { HTML: 1, CSS: 1 });
    assert.equal(r2.fileCount, 2);               // App.jsx + package.json
    assert.equal(r2.skippedBinary, 1);           // node_modules entry
    assert.ok(fs.existsSync(path.join(out, 'p_html', '.ingest.json')));

    const manifest = writeCorpus(out, 'https://x.r2.dev', [r1, r2]);
    assert.equal(manifest.totals.projects, 2);
    assert.equal(manifest.totals.files, 4);
    assert.deepEqual(manifest.totals.byType, { html: 1, react: 1 });

    for (const f of ['manifest.json', 'search-index.jsonl', 'CORPUS.md', 'AGENTS.md']) {
      assert.ok(fs.existsSync(path.join(out, f)), `missing ${f}`);
    }
    const jsonl = fs.readFileSync(path.join(out, 'search-index.jsonl'), 'utf8').trim().split('\n');
    assert.equal(jsonl.length, 4);
    assert.ok(JSON.parse(jsonl[0]).path);
    assert.match(fs.readFileSync(path.join(out, 'CORPUS.md'), 'utf8'), /2 projects · 4 source files/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('writeProject blocks zip-slip path traversal', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
  try {
    const evil = makeZip([
      { name: '../escape.js', data: 'pwned' },
      { name: 'ok.js', data: 'fine' },
    ]);
    const rec = writeProject(evil, { id: 'p', folder: 'F', type: 'html' }, out);
    assert.ok(!fs.existsSync(path.join(out, 'escape.js')));        // never escaped <out>/p/
    assert.equal(rec.fileCount, 1);                                // only ok.js written
    assert.equal(rec.failed.length, 1);
    assert.match(rec.failed[0].name, /escape\.js/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
