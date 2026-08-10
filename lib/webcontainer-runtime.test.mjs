import assert from 'node:assert/strict';
import test from 'node:test';

const { prepareRuntimeProject, RUNTIME_PROJECT_ERROR } = await import('./webcontainer-runtime.ts');

function bytes(value) {
  return new TextEncoder().encode(value).buffer;
}

function zip(entries) {
  return {
    names: Object.keys(entries),
    files: new Map(Object.entries(entries).map(([name, value]) => [
      name,
      value instanceof ArrayBuffer ? value : bytes(value),
    ])),
  };
}

test('rejects archive paths that could escape or pollute the mounted filesystem', () => {
  const unsafePaths = [
    '/absolute/package.json',
    'C:/drive/package.json',
    'windows\\package.json',
    'nul\0package.json',
    './package.json',
    'project/../package.json',
    'project/./package.json',
    '__proto__/package.json',
    'project/constructor/package.json',
    'project/prototype/package.json',
  ];

  for (const unsafePath of unsafePaths) {
    assert.throws(
      () => prepareRuntimeProject(zip({
        [unsafePath]: JSON.stringify({ scripts: { dev: 'next dev' } }),
      })),
      (error) => error instanceof Error && error.message === RUNTIME_PROJECT_ERROR,
      unsafePath,
    );
  }
});

test('selects the shallowest usable package root and preserves file bytes in a nested tree', () => {
  const binary = new Uint8Array([0, 255, 4]).buffer;
  const prepared = prepareRuntimeProject(zip({
    'node_modules/package.json': JSON.stringify({ scripts: { dev: 'next dev' } }),
    '.next/package.json': JSON.stringify({ scripts: { dev: 'next dev' } }),
    '.git/package.json': JSON.stringify({ scripts: { dev: 'next dev' } }),
    'demo/package.json': JSON.stringify({ scripts: { dev: 'next dev' } }),
    'demo/public/logo.bin': binary,
    'README.md': 'archive root text',
  }));

  assert.equal(prepared.workingDirectory, 'demo');
  assert.deepEqual(
    [...prepared.files.demo.directory.public.directory['logo.bin'].file.contents],
    [0, 255, 4],
  );
  assert.ok(prepared.files.demo.directory['package.json'].file.contents instanceof Uint8Array);
  assert.ok(prepared.files['README.md'].file.contents instanceof Uint8Array);
  assert.equal(prepared.files.node_modules, undefined);
  assert.equal(prepared.files['.next'], undefined);
  assert.equal(prepared.files['.git'], undefined);
});

test('requires an exact lowercase package.json manifest basename', () => {
  assert.throws(
    () => prepareRuntimeProject(zip({
      'PACKAGE.JSON': JSON.stringify({ scripts: { dev: 'next dev' } }),
    })),
    (error) => error instanceof Error && error.message === RUNTIME_PROJECT_ERROR,
  );
});

test('derives npm and pnpm commands that respect lockfiles and expose Next servers', () => {
  const npm = prepareRuntimeProject(zip({
    'package.json': JSON.stringify({ scripts: { dev: 'next dev' } }),
    'package-lock.json': '{}',
  }));
  const pnpm = prepareRuntimeProject(zip({
    'example/package.json': JSON.stringify({ scripts: { start: 'next start' } }),
    'example/pnpm-lock.yaml': 'lockfileVersion: 9.0',
  }));

  assert.deepEqual(npm.installCommand, ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.deepEqual(npm.devCommand, ['npm', 'run', 'dev', '--', '--hostname', '0.0.0.0']);
  assert.deepEqual(pnpm.installCommand, ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']);
  assert.deepEqual(pnpm.devCommand, ['corepack', 'pnpm', 'start', '--hostname', '0.0.0.0']);
});

test('uses a pnpm packageManager declaration when no pnpm lockfile is present', () => {
  const prepared = prepareRuntimeProject(zip({
    'package.json': JSON.stringify({
      packageManager: 'pnpm@9.15.0',
      scripts: { dev: 'next dev' },
    }),
  }));

  assert.deepEqual(prepared.installCommand, ['corepack', 'pnpm', 'install', '--ignore-scripts']);
  assert.deepEqual(prepared.devCommand, ['corepack', 'pnpm', 'dev', '--hostname', '0.0.0.0']);
});

test('forces webpack for a Next dependency with a dev script', () => {
  const prepared = prepareRuntimeProject(zip({
    'package.json': JSON.stringify({
      dependencies: { next: '16.2.3' },
      scripts: { dev: 'next dev' },
    }),
  }));

  assert.deepEqual(
    prepared.devCommand,
    ['npm', 'run', 'dev', '--', '--hostname', '0.0.0.0', '--webpack'],
  );
});

test('leaves Next start and non-Next dev commands free of the webpack flag', () => {
  const nextStart = prepareRuntimeProject(zip({
    'package.json': JSON.stringify({
      dependencies: { next: '16.2.3' },
      scripts: { start: 'next start' },
    }),
  }));
  const viteDev = prepareRuntimeProject(zip({
    'package.json': JSON.stringify({
      dependencies: { vite: '7.0.0' },
      scripts: { dev: 'vite' },
    }),
  }));

  assert.deepEqual(
    nextStart.devCommand,
    ['npm', 'run', 'start', '--', '--hostname', '0.0.0.0'],
  );
  assert.deepEqual(viteDev.devCommand, ['npm', 'run', 'dev']);
});

test('normalizes missing, malformed, and non-runnable package manifests', () => {
  const invalidProjects = [
    zip({ 'src/page.tsx': 'export default function Page() {}' }),
    zip({ 'package.json': '{not json}' }),
    zip({ 'package.json': JSON.stringify({ scripts: { build: 'next build' } }) }),
  ];

  for (const project of invalidProjects) {
    assert.throws(
      () => prepareRuntimeProject(project),
      (error) => error instanceof Error && error.message === RUNTIME_PROJECT_ERROR,
    );
  }
});
