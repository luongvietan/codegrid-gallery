import { deflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyRuntime,
  inspectTemplateArchive,
  projectTypeForRuntime,
  validateArchiveRecords,
} from './preview-classifier.mjs';

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const source = Buffer.from(entry.contents || '');
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(source) : source;
    const unixMode = entry.unixMode ?? 0;
    const local = Buffer.alloc(30 + name.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    compressed.copy(local, 30 + name.length);
    localParts.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.uncompressedSize ?? source.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((unixMode << 16) >>> 0, 38);
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

test('classifyRuntime distinguishes the five supported profiles', () => {
  const cases = [
    { names: ['index.html'], pkg: null, runtime: 'html' },
    { names: ['demo/package.json'], pkg: { dependencies: { vite: '^7.0.0' } }, runtime: 'vite-vanilla' },
    { names: ['demo/package.json'], pkg: { dependencies: { vite: '^7.0.0', react: '^19.0.0' } }, runtime: 'vite-react' },
    { names: ['demo/package.json'], pkg: { dependencies: { 'react-scripts': '5.0.1' } }, runtime: 'cra' },
    { names: ['demo/package.json'], pkg: { dependencies: { next: '16.0.1' } }, runtime: 'nextjs' },
  ];

  for (const { names, pkg, runtime } of cases) {
    assert.equal(classifyRuntime(names, pkg), runtime);
  }
});

test('next dependency wins even without next.config', () => {
  assert.equal(classifyRuntime(['demo/package.json'], { dependencies: { next: '14.2.0', react: '^18' } }), 'nextjs');
});

test('archive validation rejects traversal and symlinks', () => {
  assert.throws(() => validateArchiveRecords([{ name: '../escape.js', uncompressedSize: 1, unixMode: 0 }]), /unsafe path/i);
  assert.throws(() => validateArchiveRecords([{ name: 'demo/link', uncompressedSize: 1, unixMode: 0o120777 }]), /symbolic link/i);
});

test('inspection rejects symbolic-link records before reading a manifest', () => {
  const archive = zip([
    { name: 'package.json', contents: '{not valid json}' },
    { name: 'link', unixMode: 0o120777 },
  ]);

  assert.throws(() => inspectTemplateArchive(archive), /symbolic link/i);
});

test('archive validation rejects oversized entry counts and expanded content', () => {
  assert.throws(() => validateArchiveRecords(Array.from({ length: 10_001 }, (_, i) => ({ name: `file-${i}`, uncompressedSize: 1, unixMode: 0 }))), /entries/i);
  assert.throws(() => validateArchiveRecords([{ name: 'large.bin', uncompressedSize: 750 * 1024 * 1024 + 1, unixMode: 0 }]), /expanded/i);
});

test('inspection rejects a manifest whose actual inflated size exceeds its central-directory size', () => {
  const archive = zip([
    { name: 'package.json', contents: JSON.stringify({ dependencies: { vite: '^7.0.0' } }), uncompressedSize: 1 },
  ]);

  assert.throws(() => inspectTemplateArchive(archive), /expanded size/i);
});

test('inspection chooses the shallowest non-node_modules manifest and derives Vite commands', () => {
  const manifest = JSON.stringify({ dependencies: { vite: '^7.1.0', react: '^19.0.0' }, scripts: { dev: 'vite' } });
  const archive = zip([
    { name: 'demo/package.json', contents: manifest, unixMode: 0o100644 },
    { name: 'demo/pnpm-lock.yaml', contents: 'lockfileVersion: 9' },
    { name: 'demo/node_modules/other/package.json', contents: JSON.stringify({ dependencies: { next: '16.0.1' } }) },
  ]);

  const result = inspectTemplateArchive(archive);

  assert.equal(result.root, 'demo/');
  assert.equal(result.runtime, 'vite-react');
  assert.equal(result.packageManager, 'pnpm');
  assert.deepEqual(result.installCommand, ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']);
  assert.deepEqual(result.devCommand, ['corepack', 'pnpm', 'dev']);
  assert.deepEqual(result.buildCommand, ['npx', '--no-install', 'vite', 'build', '--base=./']);
  assert.equal(result.frameworkVersion, '^7.1.0');
  assert.equal(result.records[0].name, 'demo/package.json');
  assert.equal(result.records[0].compressionMethod, 8);
  assert.equal(result.records[0].compressedSize, deflateRawSync(Buffer.from(manifest)).length);
  assert.equal(result.records[0].uncompressedSize, Buffer.byteLength(manifest));
  assert.equal(result.records[0].localHeaderOffset, 0);
  assert.equal(result.records[0].unixMode, 0o100644);
  assert.deepEqual(result.names, ['demo/package.json', 'demo/pnpm-lock.yaml', 'demo/node_modules/other/package.json']);
});

test('inspection chooses npm commands and framework version from dependencies before devDependencies', () => {
  const archive = zip([
    { name: 'package.json', contents: JSON.stringify({ dependencies: { 'react-scripts': '5.0.1' }, devDependencies: { 'react-scripts': '0.0.0' }, scripts: { start: 'react-scripts start' } }) },
    { name: 'package-lock.json', contents: '{}' },
  ]);

  const result = inspectTemplateArchive(archive);

  assert.equal(result.root, '');
  assert.equal(result.runtime, 'cra');
  assert.deepEqual(result.installCommand, ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.deepEqual(result.devCommand, ['npm', 'start']);
  assert.deepEqual(result.buildCommand, ['npm', 'run', 'build']);
  assert.equal(result.frameworkVersion, '5.0.1');
});

test('inspection leaves Next.js and unsupported projects without a static build command', () => {
  const next = inspectTemplateArchive(zip([
    { name: 'package.json', contents: JSON.stringify({ dependencies: { next: '16.0.1' } }) },
  ]));
  const unsupported = inspectTemplateArchive(zip([
    { name: 'package.json', contents: JSON.stringify({ dependencies: { express: '5.0.0' } }) },
  ]));

  assert.equal(next.runtime, 'nextjs');
  assert.equal(next.buildCommand, null);
  assert.equal(next.frameworkVersion, '16.0.1');
  assert.equal(unsupported.runtime, 'unsupported');
  assert.equal(unsupported.buildCommand, null);
  assert.equal(unsupported.frameworkVersion, null);
});

test('project type preserves broad existing filter buckets', () => {
  assert.equal(projectTypeForRuntime('html'), 'html');
  assert.equal(projectTypeForRuntime('vite-vanilla'), 'react');
  assert.equal(projectTypeForRuntime('vite-react'), 'react');
  assert.equal(projectTypeForRuntime('cra'), 'react');
  assert.equal(projectTypeForRuntime('nextjs'), 'nextjs');
});
