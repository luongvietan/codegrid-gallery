import type {
  BootOptions,
  FileSystemTree,
  WebContainerProcess,
} from '@webcontainer/api';
import {
  prepareRuntimeProject,
  UnsupportedRuntimeError,
  type RuntimeProject,
} from './webcontainer-runtime.ts';
import type { ExtractedZip } from './zip.ts';

export type RuntimePreviewPhase =
  | 'preparing'
  | 'booting'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'failure';
export type RuntimePreviewRecovery = 'retry' | 'reload';

export interface RuntimePreviewSnapshot {
  phase: RuntimePreviewPhase;
  message: string;
  logs: string[];
  url: string | null;
  error: string | null;
  recovery: RuntimePreviewRecovery | null;
}

export interface RuntimePreviewTimeouts {
  bootMs: number;
  installMs: number;
  startMs: number;
  serverReadyMs: number;
}

interface RuntimeContainer {
  mount(files: FileSystemTree): Promise<void>;
  spawn(command: string, args: string[], options?: { cwd?: string }): Promise<WebContainerProcess>;
  on(event: 'server-ready', listener: (port: number, url: string) => void): () => void;
  on(event: 'error', listener: (error: { message: string }) => void): () => void;
  teardown(): void;
}

interface RuntimeLogBuffer {
  push(chunk: string): void;
  snapshot(): string[];
}

interface RuntimeLease {
  container: RuntimeContainer;
  release(): void;
}

interface RunRuntimePreviewOptions {
  zip: ExtractedZip;
  signal: AbortSignal;
  onUpdate(snapshot: RuntimePreviewSnapshot): void;
  boot(options: Pick<BootOptions, 'coep'>): Promise<RuntimeContainer>;
  prepare?: (zip: ExtractedZip) => RuntimeProject;
  timeouts?: Partial<RuntimePreviewTimeouts>;
}

const PHASE_MESSAGE: Record<Exclude<RuntimePreviewPhase, 'failure'>, string> = {
  preparing: 'Đang chuẩn bị project…',
  booting: 'Đang khởi động runtime…',
  installing: 'Đang cài dependencies…',
  starting: 'Đang khởi động dev server…',
  ready: 'Runtime đã sẵn sàng.',
};

const CANCELLED = Symbol('runtime-preview-cancelled');
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const DEFAULT_TIMEOUTS: RuntimePreviewTimeouts = {
  bootMs: 30_000,
  installMs: 120_000,
  startMs: 60_000,
  serverReadyMs: 60_000,
};
let bootQueue: Promise<void> = Promise.resolve();

class BootTimeoutError extends Error {}

export function runtimeRecoveryPolicy(recovery: RuntimePreviewRecovery | null): {
  action: RuntimePreviewRecovery;
  label: string;
} | null {
  if (recovery === 'reload') return { action: 'reload', label: 'Tải lại trang' };
  if (recovery === 'retry') return { action: 'retry', label: 'Thử lại' };
  return null;
}

export function createRuntimeLogBuffer({
  maxLines = 80,
  maxLineLength = 500,
}: { maxLines?: number; maxLineLength?: number } = {}): RuntimeLogBuffer {
  let completeLines: string[] = [];
  let pending = '';

  function boundedLine(line: string): string {
    return line.length > maxLineLength ? line.slice(-maxLineLength) : line;
  }

  return {
    push(chunk) {
      const lines = `${pending}${chunk.replace(ANSI_ESCAPE, '').replaceAll('\r', '')}`.split('\n');
      pending = boundedLine(lines.pop() ?? '');
      completeLines = [...completeLines, ...lines.map(boundedLine).filter(Boolean)].slice(-maxLines);
    },
    snapshot() {
      return [...completeLines, ...(pending ? [pending] : [])].slice(-maxLines);
    },
  };
}

export function normalizeRuntimeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (
    error
    && typeof error === 'object'
    && 'message' in error
    && typeof error.message === 'string'
    && error.message.trim()
  ) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'Runtime preview failed.';
}

async function acquireRuntime(
  boot: RunRuntimePreviewOptions['boot'],
  signal: AbortSignal,
): Promise<RuntimeLease | null> {
  const previous = bootQueue.catch(() => {});
  let releaseSlot = () => {};
  const slot = new Promise<void>((resolve) => { releaseSlot = resolve; });
  let slotReleased = false;
  const releaseSchedulingSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    releaseSlot();
  };
  bootQueue = previous.then(() => slot);

  await previous;
  if (signal.aborted) {
    releaseSchedulingSlot();
    return null;
  }

  try {
    const container = await boot({ coep: 'credentialless' });
    if (signal.aborted) {
      try { container.teardown(); } finally { releaseSchedulingSlot(); }
      return null;
    }

    let released = false;
    return {
      container,
      release() {
        if (released) return;
        released = true;
        try { container.teardown(); } finally { releaseSchedulingSlot(); }
      },
    };
  } catch (error) {
    releaseSchedulingSlot();
    throw error;
  }
}

function commandName(command: string, args: string[]): string {
  if (command === 'corepack') return [command, ...args.slice(0, 2)].join(' ');
  return [command, args[0]].filter(Boolean).join(' ');
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutFailure: Error,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeoutFailure);
      onTimeout();
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runRuntimePreview({
  zip,
  signal,
  onUpdate,
  boot,
  prepare = prepareRuntimeProject,
  timeouts: timeoutOverrides,
}: RunRuntimePreviewOptions): Promise<void> {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...timeoutOverrides };
  const lifecycle = new AbortController();
  const logs = createRuntimeLogBuffer();
  const readers = new Set<ReadableStreamDefaultReader<string>>();
  const processes = new Set<WebContainerProcess>();
  const unsubscribers = new Set<() => void>();
  const leaseState: { current: RuntimeLease | null } = { current: null };
  let phase: RuntimePreviewPhase = 'preparing';
  let url: string | null = null;
  let error: string | null = null;
  let unsupported = false;
  let recovery: RuntimePreviewRecovery | null = null;
  let cancelRun = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancelRun = () => {
      lifecycle.abort();
      reject(CANCELLED);
    };
    if (signal.aborted) cancelRun();
    else signal.addEventListener('abort', cancelRun, { once: true });
  });
  const stopped = new Promise<never>((_resolve, reject) => {
    const stop = () => reject(CANCELLED);
    if (lifecycle.signal.aborted) stop();
    else lifecycle.signal.addEventListener('abort', stop, { once: true });
  });
  // These reject on teardown even when no race is waiting on them — for instance when the
  // project is rejected before the first spawn. Keep their rejections handled.
  void cancelled.catch(() => {});
  void stopped.catch(() => {});

  const emit = () => {
    if (signal.aborted) return;
    onUpdate({
      phase,
      message: phase === 'failure'
        ? (unsupported ? String(error) : `Lỗi runtime: ${error}`)
        : PHASE_MESSAGE[phase],
      logs: logs.snapshot(),
      url,
      error,
      recovery,
    });
  };
  const setPhase = (nextPhase: RuntimePreviewPhase) => {
    phase = nextPhase;
    emit();
  };
  const streamOutput = async (process: WebContainerProcess) => {
    const reader = process.output.getReader();
    readers.add(reader);
    try {
      while (!lifecycle.signal.aborted) {
        const result = await reader.read();
        if (result.done) return;
        logs.push(result.value);
        emit();
      }
    } catch (streamError) {
      if (!lifecycle.signal.aborted) throw streamError;
    } finally {
      readers.delete(reader);
      reader.releaseLock();
    }
  };
  const spawnTracked = async (
    container: RuntimeContainer,
    command: string,
    args: string[],
    workingDirectory: string,
  ) => {
    const process = await container.spawn(command, args, { cwd: workingDirectory });
    if (lifecycle.signal.aborted) {
      try { process.kill(); } catch {}
      throw CANCELLED;
    }
    processes.add(process);
    return process;
  };

  emit();
  try {
    const project = prepare(zip);
    let rejectRuntimeError: (reason: unknown) => void = () => {};
    const runtimeError = new Promise<never>((_resolve, reject) => { rejectRuntimeError = reject; });

    setPhase('booting');
    await withDeadline((async () => {
      const acquiredLease = await Promise.race([
        acquireRuntime(boot, lifecycle.signal),
        cancelled,
        stopped,
      ]);
      if (!acquiredLease) throw CANCELLED;
      leaseState.current = acquiredLease;
      unsubscribers.add(acquiredLease.container.on('error', (runtimeFailure) => {
        rejectRuntimeError(new Error(normalizeRuntimeError(runtimeFailure)));
      }));
      await Promise.race([
        acquiredLease.container.mount(project.files),
        runtimeError,
        cancelled,
        stopped,
      ]);
    })(), timeouts.bootMs, new BootTimeoutError('Runtime boot timed out.'), () => lifecycle.abort());
    const activeLease = leaseState.current;
    if (!activeLease) throw CANCELLED;

    setPhase('installing');
    const [installCommand, ...installArgs] = project.installCommand;
    await withDeadline((async () => {
      const install = await Promise.race([
        spawnTracked(activeLease.container, installCommand, installArgs, project.workingDirectory),
        runtimeError,
        cancelled,
        stopped,
      ]);
      const installOutput = streamOutput(install).catch((streamError) => {
        rejectRuntimeError(streamError);
      });
      const installExit = await Promise.race([
        install.exit,
        runtimeError,
        cancelled,
        stopped,
      ]);
      await Promise.race([installOutput, runtimeError, cancelled, stopped]);
      if (installExit !== 0) {
        throw new Error(`${commandName(installCommand, installArgs)} exited with code ${installExit}.`);
      }
    })(), timeouts.installMs, new Error('Dependency install timed out.'), () => lifecycle.abort());

    setPhase('starting');
    let serverReady: (readyUrl: string) => void = () => {};
    const ready = new Promise<string>((resolve) => { serverReady = resolve; });
    unsubscribers.add(activeLease.container.on('server-ready', (_port, readyUrl) => serverReady(readyUrl)));

    const [devCommand, ...devArgs] = project.devCommand;
    const dev = await withDeadline(Promise.race([
      spawnTracked(activeLease.container, devCommand, devArgs, project.workingDirectory),
      runtimeError,
      cancelled,
      stopped,
    ]), timeouts.startMs, new Error('Dev server start timed out.'), () => lifecycle.abort());
    void streamOutput(dev).catch((streamError) => rejectRuntimeError(streamError));
    const devExit = dev.exit.then((exitCode) => {
      throw new Error(`${commandName(devCommand, devArgs)} exited with code ${exitCode}.`);
    });

    url = await withDeadline(Promise.race([
      ready,
      devExit,
      runtimeError,
      cancelled,
      stopped,
    ]), timeouts.serverReadyMs, new Error('Server readiness timed out.'), () => lifecycle.abort());
    setPhase('ready');
    await Promise.race([devExit, runtimeError, cancelled, stopped]);
  } catch (runtimeFailure) {
    if (runtimeFailure !== CANCELLED && !signal.aborted) {
      phase = 'failure';
      error = normalizeRuntimeError(runtimeFailure);
      unsupported = runtimeFailure instanceof UnsupportedRuntimeError;
      recovery = runtimeFailure instanceof BootTimeoutError
        ? 'reload'
        : runtimeFailure instanceof UnsupportedRuntimeError
          ? null
          : 'retry';
      emit();
    }
  } finally {
    signal.removeEventListener('abort', cancelRun);
    lifecycle.abort();
    for (const unsubscribe of unsubscribers) {
      try { unsubscribe(); } catch {}
    }
    for (const process of processes) {
      try { process.kill(); } catch {}
    }
    await Promise.allSettled([...readers].map((reader) => reader.cancel()));
    leaseState.current?.release();
  }
}
