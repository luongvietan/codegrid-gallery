import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildStaticPreview, dockerInvocation, sourceHash } from './preview-builder.mjs';

const paths = {
  projectDir: 'C:\\preview\\project',
  cacheDir: 'C:\\preview\\npm-cache',
};

const craInspection = {
  runtime: 'cra',
  installCommand: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
  buildCommand: ['npm', 'run', 'build'],
};

const viteInspection = {
  runtime: 'vite-react',
  installCommand: ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
  buildCommand: ['npx', '--no-install', 'vite', 'build', '--base=./'],
};

function createViteOutput(t, prefix) {
  const temporaryDir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(temporaryDir, { recursive: true, force: true }));
  const projectDir = join(temporaryDir, 'project');
  mkdirSync(join(projectDir, 'dist'), { recursive: true });
  writeFileSync(join(projectDir, 'dist', 'index.html'), '<h1>preview</h1>');
  return { projectDir, cacheDir: join(temporaryDir, 'npm-cache') };
}

test('source hash changes with builder version or runtime', () => {
  const zip = Buffer.from('same source');

  assert.notEqual(sourceHash(zip, 'vite-vanilla', 1), sourceHash(zip, 'vite-vanilla', 2));
  assert.notEqual(sourceHash(zip, 'vite-vanilla', 1), sourceHash(zip, 'vite-react', 1));
});

test('build container has no network and no secret environment forwarding', () => {
  const args = dockerInvocation('build', craInspection, paths).args;

  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('--memory=2g'));
  assert.ok(args.includes('--cpus=2'));
  assert.ok(args.includes('--pids-limit=256'));
  assert.deepEqual(args.filter((arg) => arg.startsWith('--network=')), ['--network=none']);
  assert.deepEqual(args.filter((arg) => arg.startsWith('--memory=')), ['--memory=2g']);
  assert.deepEqual(args.filter((arg) => arg.startsWith('--cpus=')), ['--cpus=2']);
  assert.deepEqual(args.filter((arg) => arg.startsWith('--pids-limit=')), ['--pids-limit=256']);
  assert.equal(args.some((arg) => arg.includes('/root/.npm') || arg.includes('/npm-cache')), false);
  const containerUser = args[args.indexOf('--user') + 1];
  assert.match(containerUser, /^[1-9]\d*:[1-9]\d*$/);
  assert.equal(args.some((arg) => /DISCORD|R2_|VERCEL|GITHUB_TOKEN/.test(arg)), false);
});

test('install container can use the shared npm cache and disables lifecycle scripts', () => {
  const args = dockerInvocation('install', craInspection, {
    ...paths,
    containerName: 'codegallery-install-cache-test',
    containerUser: '1234:5678',
  }).args;

  assert.ok(args.includes('--network=bridge'));
  assert.deepEqual(args.slice(args.indexOf('--user'), args.indexOf('--user') + 2), ['--user', '1234:5678']);
  assert.ok(args.includes(`${paths.cacheDir}:/npm-cache`));
  assert.ok(args.includes('HOME=/tmp'));
  assert.deepEqual(args.slice(args.indexOf('NPM_CONFIG_CACHE=/npm-cache') - 1, args.indexOf('NPM_CONFIG_CACHE=/npm-cache') + 1), [
    '-e',
    'NPM_CONFIG_CACHE=/npm-cache',
  ]);
  assert.deepEqual(args.slice(-5), ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
});

test('CRA build sets a relative public URL inside the container', () => {
  const args = dockerInvocation('build', craInspection, paths).args;
  const imageIndex = args.indexOf('node:20-bookworm-slim');

  assert.deepEqual(args.slice(imageIndex - 2, imageIndex), ['-e', 'PUBLIC_URL=.']);
});

test('Vite output uses a relative base', () => {
  const args = dockerInvocation('build', viteInspection, paths).args;

  assert.deepEqual(args.slice(-5), ['npx', '--no-install', 'vite', 'build', '--base=./']);
});

test('builder installs then builds and returns a ready manifest', async (t) => {
  const calls = [];
  const outputPaths = createViteOutput(t, 'preview-builder-ready-');
  const runProcess = async (invocation) => {
    calls.push(invocation.phase);
    return { code: 0, stdout: '', stderr: '' };
  };

  const result = await buildStaticPreview({
    inspection: viteInspection,
    zipBuffer: Buffer.from('vite source'),
    ...outputPaths,
    runProcess,
  });

  assert.deepEqual(calls, ['install', 'build']);
  assert.equal(result.preview.mode, 'static');
  assert.equal(result.preview.status, 'ready');
  assert.equal(result.preview.entry, 'index.html');
  assert.equal(result.preview.sourceHash, 'sha256:bf5cb39ef4d55f115005e932bbb39b533d7205f6096aa07b8bcc80fae613ad68');
  assert.equal(result.preview.artifactBase, 'previews/sha256:bf5cb39ef4d55f115005e932bbb39b533d7205f6096aa07b8bcc80fae613ad68/');
  assert.equal(result.outputDir, join(outputPaths.projectDir, 'dist'));
});

test('failed build falls back to webcontainer without throwing', async () => {
  const runProcess = async ({ phase }) => phase === 'install'
    ? { code: 0, stdout: '', stderr: '' }
    : { code: 1, stdout: '', stderr: 'config failed' };

  const result = await buildStaticPreview({
    inspection: viteInspection,
    zipBuffer: Buffer.from('broken vite source'),
    ...paths,
    runProcess,
  });

  assert.equal(result.preview.status, 'build-failed');
  assert.equal(result.preview.mode, 'webcontainer');
  assert.equal(result.preview.failureCode, 'build-failed');
});

test('runner receives exact phase timeouts, buffer cap, and an allowlisted host environment', async () => {
  const invocations = [];
  const runProcess = async (invocation) => {
    invocations.push(invocation);
    return { code: 0, stdout: '', stderr: '' };
  };

  await buildStaticPreview({
    inspection: viteInspection,
    zipBuffer: Buffer.from('bounded build'),
    ...paths,
    runProcess,
    outputExists: () => true,
  });

  assert.deepEqual(invocations.map(({ phase, timeout, maxBuffer }) => ({ phase, timeout, maxBuffer })), [
    { phase: 'install', timeout: 480_000, maxBuffer: 64 * 1024 },
    { phase: 'build', timeout: 300_000, maxBuffer: 64 * 1024 },
  ]);
  for (const { env } of invocations) {
    assert.equal(Object.keys(env).every((key) => ['PATH', 'SystemRoot', 'TEMP', 'TMP'].includes(key)), true);
    assert.equal(Object.keys(env).some((key) => /DISCORD|R2_|VERCEL|GITHUB_TOKEN/.test(key)), false);
  }
});

test('install failure stops before build and exposes only a normalized failure', async () => {
  const calls = [];
  const result = await buildStaticPreview({
    inspection: viteInspection,
    zipBuffer: Buffer.from('install failure'),
    ...paths,
    runProcess: async ({ phase }) => {
      calls.push(phase);
      return { code: 1, stdout: '', stderr: 'registry unavailable' };
    },
  });

  assert.deepEqual(calls, ['install', 'cleanup']);
  assert.equal(calls.includes('build'), false);
  assert.equal(result.status, 'install-failed');
  assert.equal(result.preview.status, 'build-failed');
  assert.equal(result.preview.failureCode, 'install-failed');
});

test('thrown build timeout is normalized and public log contains at most the final 4 KiB', async () => {
  const result = await buildStaticPreview({
    inspection: viteInspection,
    zipBuffer: Buffer.from('timeout'),
    ...paths,
    runProcess: async ({ phase }) => {
      if (phase === 'install') return { code: 0, stdout: 'install complete', stderr: '' };
      throw Object.assign(new Error('build timed out'), { stderr: `${'x'.repeat(70_000)}tail` });
    },
  });

  assert.equal(result.status, 'build-failed');
  assert.equal(result.preview.failureCode, 'build-failed');
  assert.ok(Buffer.byteLength(result.log) <= 4 * 1024);
  assert.ok(result.log.endsWith('build timed out'));
});

test('Next.js and unsupported profiles return fallback manifests without running Docker', async () => {
  let calls = 0;
  const runProcess = async () => {
    calls += 1;
    throw new Error('must not run');
  };
  const next = await buildStaticPreview({
    inspection: { ...viteInspection, runtime: 'nextjs', buildCommand: null },
    zipBuffer: Buffer.from('next'),
    ...paths,
    runProcess,
  });
  const unsupported = await buildStaticPreview({
    inspection: { ...viteInspection, runtime: 'unsupported', buildCommand: null },
    zipBuffer: Buffer.from('unsupported'),
    ...paths,
    runProcess,
  });

  assert.equal(calls, 0);
  assert.equal(next.preview.mode, 'webcontainer');
  assert.equal(next.preview.status, 'runtime-required');
  assert.equal(next.preview.failureCode, null);
  assert.equal(unsupported.preview.mode, 'unavailable');
  assert.equal(unsupported.preview.status, 'unsupported');
});

test('builder rejects a symlink artifact that resolves outside the output directory', async (t) => {
  const temporaryDir = mkdtempSync(join(tmpdir(), 'preview-builder-output-'));
  t.after(() => rmSync(temporaryDir, { recursive: true, force: true }));
  const projectDir = join(temporaryDir, 'project');
  const outputDir = join(projectDir, 'dist');
  const outsideDir = join(temporaryDir, 'outside');
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(outsideDir);
  writeFileSync(join(outputDir, 'index.html'), '<h1>safe</h1>');
  writeFileSync(join(outsideDir, 'secret.txt'), 'must not publish');
  symlinkSync(outsideDir, join(outputDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

  const result = await buildStaticPreview({
    inspection: viteInspection,
    zipBuffer: Buffer.from('symlink output'),
    projectDir,
    cacheDir: join(temporaryDir, 'npm-cache'),
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
  });

  assert.notEqual(result.preview.status, 'ready');
  assert.equal(result.preview.failureCode, 'unsafe-output');
  assert.equal(result.outputDir, null);
});

test('timeout forces removal of the named container', async () => {
  const calls = [];
  const result = await buildStaticPreview({
    inspection: viteInspection,
    zipBuffer: Buffer.from('timeout cleanup'),
    ...paths,
    createContainerName: (phase) => `codegallery-${phase}-test`,
    runProcess: async (invocation) => {
      calls.push(invocation);
      if (invocation.phase === 'build') {
        throw Object.assign(new Error('build timed out'), { code: 'ETIMEDOUT' });
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.status, 'build-failed');
  assert.deepEqual(calls.map(({ phase }) => phase), ['install', 'build', 'cleanup']);
  const runNameIndex = calls[1].args.indexOf('--name');
  assert.equal(calls[1].args[runNameIndex + 1], 'codegallery-build-test');
  assert.deepEqual(calls[2].args, ['rm', '-f', 'codegallery-build-test']);
});

test('successful phases use unique validated names without forced cleanup', async (t) => {
  const outputPaths = createViteOutput(t, 'preview-builder-names-');
  const calls = [];
  let sequence = 0;
  const result = await buildStaticPreview({
    inspection: viteInspection,
    zipBuffer: Buffer.from('successful named containers'),
    ...outputPaths,
    createContainerName: (phase) => `codegallery-${phase}-${++sequence}`,
    runProcess: async (invocation) => {
      calls.push(invocation);
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.status, 'ready');
  assert.deepEqual(calls.map(({ phase }) => phase), ['install', 'build']);
  const names = calls.map(({ args }) => args[args.indexOf('--name') + 1]);
  assert.deepEqual(names, ['codegallery-install-1', 'codegallery-build-2']);
  assert.notEqual(names[0], names[1]);
  assert.equal(names.every((name) => /^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(name)), true);
});

test('builder creates the shared cache before a non-root install starts', async (t) => {
  const outputPaths = createViteOutput(t, 'preview-builder-cache-');
  const result = await buildStaticPreview({
    inspection: viteInspection,
    zipBuffer: Buffer.from('non-root cache'),
    ...outputPaths,
    runProcess: async ({ phase }) => {
      if (phase === 'install') assert.equal(lstatSync(outputPaths.cacheDir).isDirectory(), true);
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.status, 'ready');
});
