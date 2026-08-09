import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const BUILDER_VERSION = 1;

const CONTAINER_IMAGE = 'node:20-bookworm-slim';
const CONTAINER_LIMITS = ['--memory=2g', '--cpus=2', '--pids-limit=256'];
const MAX_LOG_BYTES = 64 * 1024;
const PUBLIC_LOG_BYTES = 4 * 1024;
const PHASE_TIMEOUTS = {
  install: 480_000,
  build: 300_000,
};
const execFileAsync = promisify(execFile);

export function sourceHash(zipBuffer, runtime, builderVersion = BUILDER_VERSION) {
  return `sha256:${createHash('sha256')
    .update(`builder:${builderVersion}\nruntime:${runtime}\n`)
    .update(zipBuffer)
    .digest('hex')}`;
}

export function dockerInvocation(phase, inspection, paths) {
  const { projectDir, cacheDir } = paths;
  const network = phase === 'install' ? ['--network=bridge'] : ['--network=none'];
  const mounts = phase === 'install'
    ? ['-v', `${projectDir}:/workspace`, '-v', `${cacheDir}:/root/.npm`, '-w', '/workspace']
    : ['-v', `${projectDir}:/workspace`, '-w', '/workspace'];
  const environment = phase === 'build' && inspection.runtime === 'cra'
    ? ['-e', 'PUBLIC_URL=.']
    : [];
  const command = phase === 'install' ? inspection.installCommand : inspection.buildCommand;

  return {
    file: 'docker',
    args: [
      'run',
      '--rm',
      ...CONTAINER_LIMITS,
      ...network,
      ...mounts,
      ...environment,
      CONTAINER_IMAGE,
      ...command,
    ],
  };
}

function hostEnvironment() {
  return Object.fromEntries(
    ['PATH', 'SystemRoot', 'TEMP', 'TMP']
      .filter((name) => typeof process.env[name] === 'string')
      .map((name) => [name, process.env[name]]),
  );
}

async function defaultRunProcess(invocation) {
  const result = await execFileAsync(invocation.file, invocation.args, {
    env: invocation.env,
    timeout: invocation.timeout,
    maxBuffer: invocation.maxBuffer,
    windowsHide: true,
  });
  return { code: 0, ...result };
}

function tailBytes(value, maximumBytes) {
  const buffer = Buffer.from(String(value ?? ''));
  let start = Math.max(0, buffer.length - maximumBytes);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

function publicLog(parts) {
  return tailBytes(tailBytes(parts.filter(Boolean).join('\n'), MAX_LOG_BYTES), PUBLIC_LOG_BYTES);
}

function previewManifest(inspection, zipBuffer, overrides) {
  const hash = sourceHash(zipBuffer, inspection.runtime);
  return {
    mode: 'unavailable',
    runtime: inspection.runtime,
    sourceHash: hash,
    artifactBase: overrides.mode === 'static' && overrides.status === 'ready'
      ? `previews/${hash}/`
      : null,
    entry: null,
    status: 'unsupported',
    builderVersion: BUILDER_VERSION,
    failureCode: null,
    ...overrides,
  };
}

function fallbackResult(inspection, zipBuffer, status, log = '') {
  const unsupported = status === 'unsupported';
  const runtimeRequired = status === 'runtime-required';
  return {
    status,
    outputDir: null,
    preview: previewManifest(inspection, zipBuffer, {
      mode: unsupported ? 'unavailable' : 'webcontainer',
      status: unsupported ? 'unsupported' : runtimeRequired ? 'runtime-required' : 'build-failed',
      failureCode: runtimeRequired ? null : status,
    }),
    log: publicLog([log]),
  };
}

async function runPhase(phase, inspection, paths, runProcess) {
  const invocation = {
    phase,
    ...dockerInvocation(phase, inspection, paths),
    timeout: PHASE_TIMEOUTS[phase],
    maxBuffer: MAX_LOG_BYTES,
    env: hostEnvironment(),
  };
  try {
    const result = await runProcess(invocation);
    return {
      code: result?.code ?? 0,
      log: publicLog([result?.stdout, result?.stderr]),
    };
  } catch (error) {
    return {
      code: typeof error?.code === 'number' ? error.code : 1,
      log: publicLog([error?.stdout, error?.stderr, error?.message]),
    };
  }
}

export async function buildStaticPreview(options) {
  const {
    inspection,
    zipBuffer,
    projectDir,
    cacheDir,
    runProcess = defaultRunProcess,
    outputExists = existsSync,
  } = options;

  if (inspection.runtime === 'nextjs') {
    return fallbackResult(inspection, zipBuffer, 'runtime-required');
  }
  if (inspection.runtime === 'unsupported') {
    return fallbackResult(inspection, zipBuffer, 'unsupported');
  }
  if (inspection.runtime === 'html') {
    return {
      status: 'ready',
      outputDir: projectDir,
      preview: previewManifest(inspection, zipBuffer, {
        mode: 'html',
        entry: 'index.html',
        status: 'ready',
      }),
      log: '',
    };
  }

  const paths = { projectDir, cacheDir };
  const install = await runPhase('install', inspection, paths, runProcess);
  if (install.code !== 0) {
    return fallbackResult(inspection, zipBuffer, 'install-failed', install.log);
  }

  const build = await runPhase('build', inspection, paths, runProcess);
  const log = publicLog([install.log, build.log]);
  const outputDir = join(projectDir, inspection.runtime === 'cra' ? 'build' : 'dist');
  if (build.code !== 0 || !outputExists(outputDir)) {
    return fallbackResult(inspection, zipBuffer, 'build-failed', log);
  }

  return {
    status: 'ready',
    outputDir,
    preview: previewManifest(inspection, zipBuffer, {
      mode: 'static',
      entry: 'index.html',
      status: 'ready',
    }),
    log,
  };
}
