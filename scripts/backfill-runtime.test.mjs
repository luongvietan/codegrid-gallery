import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  entriesNeedingRuntime,
  inspectRemoteArchive,
  realignTypes,
  runtimeCounts,
  typeCounts,
} from './backfill-runtime.mjs';

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const source = Buffer.from(entry.contents || '');
    const compressed = deflateRawSync(source);
    const local = Buffer.alloc(30 + name.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    compressed.copy(local, 30 + name.length);
    localParts.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length;
  }

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, eocd]);
}

/** Serves byte ranges out of a buffer and records how much of it was actually requested. */
function rangeServer(archive) {
  const served = [];
  return {
    served,
    get bytesServed() { return served.reduce((total, range) => total + range.length, 0); },
    async fetchRange(_url, range) {
      const start = range.suffix !== undefined
        ? Math.max(0, archive.length - range.suffix)
        : range.start;
      const end = range.suffix !== undefined ? archive.length : Math.min(range.end + 1, archive.length);
      const slice = archive.subarray(start, end);
      served.push({ start, length: slice.length });
      return { body: Buffer.from(slice), totalSize: archive.length };
    },
  };
}

test('classifies a remote archive without downloading the whole file', async () => {
  // Incompressible, so the archive really is large and a full download would be visible.
  const filler = randomBytes(400_000);
  const archive = zip([
    { name: 'demo/package.json', contents: JSON.stringify({ dependencies: { vite: '5.0.0' } }) },
    { name: 'demo/index.html', contents: '<!doctype html>' },
    { name: 'demo/assets/blob.bin', contents: filler },
  ]);
  const server = rangeServer(archive);

  const inspection = await inspectRemoteArchive('https://cdn.test/CODE.zip', server.fetchRange);

  assert.equal(inspection.runtime, 'vite-vanilla');
  assert.ok(
    server.bytesServed < archive.length / 2,
    `served ${server.bytesServed} of ${archive.length} bytes`,
  );
});

test('separates a React build tool from a plain Vite one', async () => {
  const viteReact = zip([{
    name: 'demo/package.json',
    contents: JSON.stringify({ dependencies: { vite: '5.0.0', react: '19.0.0' } }),
  }]);
  const server = rangeServer(viteReact);

  const inspection = await inspectRemoteArchive('https://cdn.test/CODE.zip', server.fetchRange);

  assert.equal(inspection.runtime, 'vite-react');
});

test('classifies a manifest-free archive from its central directory alone', async () => {
  const htmlOnly = zip([
    { name: 'demo/index.html', contents: '<!doctype html>' },
    { name: 'demo/styles.css', contents: 'body{}' },
  ]);
  const server = rangeServer(htmlOnly);

  const inspection = await inspectRemoteArchive('https://cdn.test/CODE.zip', server.fetchRange);

  assert.equal(inspection.runtime, 'html');
});

test('selects only entries that still lack a runtime, honouring the batch limit', () => {
  const projects = [
    { id: 'a', zip: 'CODE.zip', runtime: 'html' },
    { id: 'b', zip: 'CODE.zip' },
    { id: 'c', zip: null },
    { id: 'd', zip: 'CODE.zip' },
  ];

  assert.deepEqual(entriesNeedingRuntime(projects).map((p) => p.id), ['b', 'd']);
  assert.deepEqual(entriesNeedingRuntime(projects, 1).map((p) => p.id), ['b']);
});

test('realigns a legacy type that the measured runtime contradicts', () => {
  const projects = [
    { folder: 'a', type: 'react', runtime: 'nextjs' },
    { folder: 'b', type: 'react', runtime: 'vite-vanilla' },
    { folder: 'c', type: 'html', runtime: 'html' },
    { folder: 'd', type: 'react' },
  ];

  const corrections = realignTypes(projects);

  assert.deepEqual(corrections, [{ folder: 'a', from: 'react', to: 'nextjs', runtime: 'nextjs' }]);
  assert.equal(projects[0].type, 'nextjs');
  assert.equal(projects[1].type, 'react', 'vite-vanilla keeps the react preview route');
  assert.equal(projects[3].type, 'react', 'an unclassified project is left alone');
  assert.deepEqual(typeCounts(projects), { nextjs: 1, react: 2, html: 1 });
});

test('counts runtimes for the summary the backfill prints', () => {
  assert.deepEqual(
    runtimeCounts([
      { runtime: 'html' },
      { runtime: 'html' },
      { runtime: 'vite-vanilla' },
      {},
    ]),
    { html: 2, 'vite-vanilla': 1, unknown: 1 },
  );
});
