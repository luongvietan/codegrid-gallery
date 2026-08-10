import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

export const BUILDER_VERSION = 3;
export const CONTAINER_IMAGE = 'node:20.19.4-bookworm-slim@sha256:a25e59a5562406b0a4f34ce94ccad6c3902dcf3269b40e1fe12d881090c6f9be';
export const DEFAULT_ARTIFACT_LIMITS = {
  maxFiles: 25_000,
  maxBytes: 250 * 1024 * 1024,
};
export const DEFAULT_PROJECT_STORAGE_LIMITS = {
  maxEntries: 200_000,
  maxBytes: 2 * 1024 * 1024 * 1024,
};
export const DEFAULT_INSTALL_CACHE_LIMITS = {
  maxEntries: 100_000,
  maxBytes: 1024 * 1024 * 1024,
};

const CONTAINER_LIMITS = ['--memory=2g', '--cpus=2', '--pids-limit=256'];
const MAX_LOG_BYTES = 64 * 1024;
const PUBLIC_LOG_BYTES = 4 * 1024;
const PHASE_TIMEOUTS = {
  install: 480_000,
  build: 300_000,
};
const CLEANUP_TIMEOUT = 30_000;
const STORAGE_POLL_INTERVAL = 1_000;
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
      '--read-only',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
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

function artifactBudgetError(message) {
  const error = new Error(message);
  error.code = 'ARTIFACT_BUDGET_EXCEEDED';
  return error;
}

function validatedLimits(limits, label, countKey) {
  if (!limits || !Number.isSafeInteger(limits[countKey]) || limits[countKey] < 1
    || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) {
    throw new Error(`${label} limits must be positive safe integers`);
  }
  return limits;
}

export function measureStorageUsage(root, limits) {
  const bounded = validatedLimits(limits, 'Storage', 'maxEntries');
  const usage = { entryCount: 0, totalBytes: 0, exceeded: false };
  if (!existsSync(root)) return usage;

  function visit(candidate) {
    if (usage.exceeded) return;
    const stat = lstatSync(candidate);
    usage.entryCount += 1;
    if (stat.isFile() || stat.isSymbolicLink()) usage.totalBytes += stat.size;
    usage.exceeded = usage.entryCount > bounded.maxEntries || usage.totalBytes > bounded.maxBytes;
    if (usage.exceeded) return;
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of readdirSync(candidate)) visit(join(candidate, name));
    }
  }

  visit(root);
  return usage;
}

function exceedsArtifactLimits(usage, limits) {
  return usage.fileCount > limits.maxFiles || usage.totalBytes > limits.maxBytes;
}

function validateOutputDirectory(outputDir, limits = DEFAULT_ARTIFACT_LIMITS) {
  const rootStat = lstatSync(outputDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Preview output root must be a regular directory');
  }
  const resolvedRoot = realpathSync(outputDir);

  const usage = { fileCount: 0, totalBytes: 0 };
  const bounded = limits ? validatedLimits(limits, 'Artifact', 'maxFiles') : null;

  function visit(candidate) {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error('Preview output contains a symbolic link');
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('Preview output contains a special file');
    if (!resolvedPathIsInside(resolvedRoot, realpathSync(candidate))) {
      throw new Error('Preview output resolves outside its root');
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(candidate)) visit(join(candidate, name));
    } else if (stat.isFile()) {
      usage.fileCount += 1;
      usage.totalBytes += stat.size;
      if (bounded && exceedsArtifactLimits(usage, bounded)) {
        throw artifactBudgetError('Preview output exceeds the file-count or total-byte limit');
      }
    }
  }

  visit(outputDir);
  return usage;
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

async function cleanupContainer(containerName, runProcess) {
  try {
    const cleanup = await runProcess({
      phase: 'cleanup',
      file: 'docker',
      args: ['rm', '-f', containerName],
      timeout: CLEANUP_TIMEOUT,
      maxBuffer: MAX_LOG_BYTES,
      env: hostEnvironment(),
    });
    return publicLog([cleanup?.stdout, cleanup?.stderr]);
  } catch (error) {
    return publicLog([error?.stdout, error?.stderr, error?.message]);
  }
}

function measurePhaseStorage(phase, paths) {
  const targets = [
    { directory: paths.projectDir, limits: paths.projectStorageLimits, kind: 'project' },
    ...(phase === 'install'
      ? [{ directory: paths.cacheDir, limits: paths.installCacheLimits, kind: 'cache' }]
      : []),
  ];
  for (const target of targets) {
    let usage;
    try {
      usage = paths.measureStorage(target.directory, target.limits, target.kind, phase);
    } catch (error) {
      return {
        exceeded: true,
        kind: target.kind,
        log: `Unable to measure ${target.kind} storage: ${error?.message ?? error}`,
      };
    }
    if (usage.exceeded
      || usage.entryCount > target.limits.maxEntries
      || usage.totalBytes > target.limits.maxBytes) {
      return {
        exceeded: true,
        kind: target.kind,
        log: `${target.kind} storage limit exceeded (${usage.entryCount} entries, ${usage.totalBytes} bytes)`,
      };
    }
  }
  return { exceeded: false, log: '' };
}

async function monitorPhaseStorage(phase, paths, state) {
  while (!state.stopped) {
    const result = measurePhaseStorage(phase, paths);
    if (result.exceeded) return result;
    await new Promise((resolve) => {
      state.wake = resolve;
      state.timer = setTimeout(resolve, paths.storagePollIntervalMs);
    });
    state.timer = null;
    state.wake = null;
  }
  return { exceeded: false, log: '' };
}

function stopStorageMonitor(state) {
  state.stopped = true;
  if (state.timer) clearTimeout(state.timer);
  state.wake?.();
}

async function storageLimitResult(result, containerName, paths, runProcess) {
  const cleanupLog = await cleanupContainer(containerName, runProcess);
  let cacheLog = '';
  if (result.kind === 'cache') {
    try {
      rmSync(paths.cacheDir, { recursive: true, force: true });
      mkdirSync(paths.cacheDir, { recursive: true });
    } catch (error) {
      cacheLog = `Unable to clear install cache: ${error?.message ?? error}`;
    }
  }
  return {
    code: 1,
    failureCode: 'build-storage-limit',
    log: publicLog([result.log, cleanupLog, cacheLog]),
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
  const monitorState = { stopped: false, timer: null, wake: null };
  const processOutcome = Promise.resolve()
    .then(() => runProcess(invocation))
    .then((processResult) => ({
      kind: 'process',
      result: {
        code: processResult?.code === undefined ? 0 : processResult.code,
        log: publicLog([processResult?.stdout, processResult?.stderr]),
      },
    }), (error) => ({
      kind: 'process',
      result: {
        code: typeof error?.code === 'number' ? error.code : 1,
        log: publicLog([error?.stdout, error?.stderr, error?.message]),
      },
    }));
  const storageOutcome = monitorPhaseStorage(phase, paths, monitorState)
    .then((result) => ({ kind: 'storage', result }));
  const outcome = await Promise.race([processOutcome, storageOutcome]);
  stopStorageMonitor(monitorState);

  if (outcome.kind === 'storage' && outcome.result.exceeded) {
    return storageLimitResult(outcome.result, containerName, paths, runProcess);
  }
  const result = outcome.result;
  if (result.code !== 0) {
    const cleanupLog = await cleanupContainer(containerName, runProcess);
    return {
      code: result.code,
      log: publicLog([result.log, cleanupLog]),
    };
  }
  const finalStorage = measurePhaseStorage(phase, paths);
  if (finalStorage.exceeded) {
    return storageLimitResult(finalStorage, containerName, paths, runProcess);
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
    artifactLimits = DEFAULT_ARTIFACT_LIMITS,
    projectStorageLimits = DEFAULT_PROJECT_STORAGE_LIMITS,
    installCacheLimits = DEFAULT_INSTALL_CACHE_LIMITS,
    storagePollIntervalMs = STORAGE_POLL_INTERVAL,
    measureStorage = measureStorageUsage,
  } = options;

  if (inspection.runtime === 'nextjs') {
    return fallbackResult(inspection, zipBuffer, 'runtime-required');
  }
  if (inspection.runtime === 'unsupported') {
    return fallbackResult(inspection, zipBuffer, 'unsupported');
  }
  if (inspection.runtime === 'html') {
    try {
      validateOutputDirectory(projectDir, null);
    } catch (error) {
      return fallbackResult(inspection, zipBuffer, 'unsafe-output', error?.message);
    }
    return {
      status: 'ready',
      outputDir: null,
      preview: previewManifest(inspection, zipBuffer, {
        mode: 'html',
        entry: 'index.html',
        status: 'ready',
      }),
      log: '',
    };
  }

  const paths = {
    projectDir,
    cacheDir,
    createContainerName,
    containerUser,
    projectStorageLimits: validatedLimits(projectStorageLimits, 'Project storage', 'maxEntries'),
    installCacheLimits: validatedLimits(installCacheLimits, 'Install cache', 'maxEntries'),
    storagePollIntervalMs,
    measureStorage,
  };
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch (error) {
    return fallbackResult(inspection, zipBuffer, 'install-failed', error?.message);
  }
  try {
    discardForeignLockfiles(projectDir, inspection.packageManager, removeFile);
  } catch (error) {
    return fallbackResult(inspection, zipBuffer, 'install-failed', error?.message);
  }
  const install = await runPhase('install', inspection, paths, runProcess);
  if (install.code !== 0) {
    return fallbackResult(inspection, zipBuffer, install.failureCode ?? 'install-failed', install.log);
  }

  const build = await runPhase('build', inspection, paths, runProcess);
  const log = publicLog([install.log, build.log]);
  const outputDir = join(projectDir, inspection.runtime === 'cra' ? 'build' : 'dist');
  if (build.code !== 0 || !outputExists(outputDir)) {
    return fallbackResult(inspection, zipBuffer, build.failureCode ?? 'build-failed', log);
  }
  try {
    validateOutputDirectory(outputDir, artifactLimits);
  } catch (error) {
    const failureCode = error?.code === 'ARTIFACT_BUDGET_EXCEEDED' ? 'artifact-too-large' : 'unsafe-output';
    return fallbackResult(inspection, zipBuffer, failureCode, publicLog([log, error?.message]));
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

export function reusedStaticPreview(inspection, zipBuffer) {
  return {
    status: 'ready',
    outputDir: null,
    preview: previewManifest(inspection, zipBuffer, {
      mode: 'static',
      entry: 'index.html',
      status: 'ready',
    }),
    log: '',
  };
}

function removeFile(target) {
  if (!existsSync(target)) return false;
  rmSync(target, { force: true });
  return true;
}

/**
 * npm reinstates an existing lockfile's optional dependencies even on `npm install`, and these
 * archives ship lockfiles authored on macOS that name only darwin binaries. Left in place, the
 * Linux container installs no @rollup/rollup-linux-x64-gnu and the bundler dies on require
 * (npm/cli#4828, whose own error tells you to delete the lockfile). pnpm records every platform,
 * so its lockfile stays and keeps the install reproducible.
 */
export function discardForeignLockfiles(projectDir, packageManager, remove = removeFile) {
  if (packageManager === 'pnpm') return [];
  return ['package-lock.json', 'npm-shrinkwrap.json'].filter((name) => remove(join(projectDir, name)));
}

export function isStaticBuildRuntime(runtime) {
  return runtime === 'vite-vanilla' || runtime === 'vite-react' || runtime === 'cra';
}
