import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
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
const CLEANUP_TIMEOUT = 30_000;
const execFileAsync = promisify(execFile);

function defaultContainerName(phase) {
  return `codegallery-preview-${phase}-${randomUUID()}`;
}

function validateContainerName(containerName) {
  if (typeof containerName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/.test(containerName)) {
    throw new Error('Invalid Docker container name');
  }
  return containerName;
}

function defaultContainerUser() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
  return Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0
    ? `${uid}:${gid}`
    : '1000:1000';
}

function validateContainerUser(containerUser) {
  if (typeof containerUser !== 'string' || !/^[1-9]\d*:[1-9]\d*$/.test(containerUser)) {
    throw new Error('Docker container user must be a non-root numeric uid:gid');
  }
  return containerUser;
}

export function sourceHash(zipBuffer, runtime, builderVersion = BUILDER_VERSION) {
  return `sha256:${createHash('sha256')
    .update(`builder:${builderVersion}\nruntime:${runtime}\n`)
    .update(zipBuffer)
    .digest('hex')}`;
}

export function dockerInvocation(phase, inspection, paths) {
  const { projectDir, cacheDir } = paths;
  const containerName = validateContainerName(paths.containerName ?? defaultContainerName(phase));
  const containerUser = validateContainerUser(paths.containerUser ?? defaultContainerUser());
  const network = phase === 'install' ? ['--network=bridge'] : ['--network=none'];
  const mounts = phase === 'install'
    ? ['-v', `${projectDir}:/workspace`, '-v', `${cacheDir}:/npm-cache`, '-w', '/workspace']
    : ['-v', `${projectDir}:/workspace`, '-w', '/workspace'];
  const environment = [
    '-e',
    'HOME=/tmp',
    ...(phase === 'install'
      ? ['-e', 'NPM_CONFIG_CACHE=/npm-cache']
      : inspection.runtime === 'cra' ? ['-e', 'PUBLIC_URL=.'] : []),
  ];
  const command = phase === 'install' ? inspection.installCommand : inspection.buildCommand;

  return {
    file: 'docker',
    args: [
      'run',
      '--rm',
      '--name',
      containerName,
      '--user',
      containerUser,
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

function resolvedPathIsInside(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
}

function validateOutputDirectory(outputDir) {
  const rootStat = lstatSync(outputDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Preview output root must be a regular directory');
  }
  const resolvedRoot = realpathSync(outputDir);

  function visit(candidate) {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error('Preview output contains a symbolic link');
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('Preview output contains a special file');
    if (!resolvedPathIsInside(resolvedRoot, realpathSync(candidate))) {
      throw new Error('Preview output resolves outside its root');
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(candidate)) visit(join(candidate, name));
    }
  }

  visit(outputDir);
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
  const containerName = validateContainerName(paths.createContainerName(phase));
  const invocation = {
    phase,
    ...dockerInvocation(phase, inspection, { ...paths, containerName }),
    timeout: PHASE_TIMEOUTS[phase],
    maxBuffer: MAX_LOG_BYTES,
    env: hostEnvironment(),
  };
  let result;
  try {
    const processResult = await runProcess(invocation);
    result = {
      code: processResult?.code === undefined ? 0 : processResult.code,
      log: publicLog([processResult?.stdout, processResult?.stderr]),
    };
  } catch (error) {
    result = {
      code: typeof error?.code === 'number' ? error.code : 1,
      log: publicLog([error?.stdout, error?.stderr, error?.message]),
    };
  }
  if (result.code !== 0) {
    let cleanupLog = '';
    try {
      const cleanup = await runProcess({
        phase: 'cleanup',
        file: 'docker',
        args: ['rm', '-f', containerName],
        timeout: CLEANUP_TIMEOUT,
        maxBuffer: MAX_LOG_BYTES,
        env: hostEnvironment(),
      });
      cleanupLog = publicLog([cleanup?.stdout, cleanup?.stderr]);
    } catch (error) {
      cleanupLog = publicLog([error?.stdout, error?.stderr, error?.message]);
    }
    return {
      code: result.code,
      log: publicLog([result.log, cleanupLog]),
    };
  }
  return {
    code: result.code,
    log: result.log,
  };
}

export async function buildStaticPreview(options) {
  const {
    inspection,
    zipBuffer,
    projectDir,
    cacheDir,
    runProcess = defaultRunProcess,
    outputExists = existsSync,
    createContainerName = defaultContainerName,
    containerUser = defaultContainerUser(),
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

  const paths = { projectDir, cacheDir, createContainerName, containerUser };
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch (error) {
    return fallbackResult(inspection, zipBuffer, 'install-failed', error?.message);
  }
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
  try {
    validateOutputDirectory(outputDir);
  } catch (error) {
    return fallbackResult(inspection, zipBuffer, 'unsafe-output', publicLog([log, error?.message]));
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
