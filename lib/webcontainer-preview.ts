import type {
  BootOptions,
  FileSystemTree,
  WebContainerProcess,
} from '@webcontainer/api';
import { prepareRuntimeProject, type RuntimeProject } from './webcontainer-runtime.ts';
import type { ExtractedZip } from './zip.ts';

export type RuntimePreviewPhase =
  | 'preparing'
  | 'booting'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'failure';

export interface RuntimePreviewSnapshot {
  phase: RuntimePreviewPhase;
  message: string;
  logs: string[];
  url: string | null;
  error: string | null;
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
let bootQueue: Promise<void> = Promise.resolve();

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
  bootQueue = previous.then(() => slot);

  await previous;
  if (signal.aborted) {
    releaseSlot();
    return null;
  }

  try {
    const container = await boot({ coep: 'credentialless' });
    if (signal.aborted) {
      try { container.teardown(); } finally { releaseSlot(); }
      return null;
    }

    let released = false;
    return {
      container,
      release() {
        if (released) return;
        released = true;
        try { container.teardown(); } finally { releaseSlot(); }
      },
    };
  } catch (error) {
    releaseSlot();
    throw error;
  }
}

function commandName(command: string, args: string[]): string {
  if (command === 'corepack') return [command, ...args.slice(0, 2)].join(' ');
  return [command, args[0]].filter(Boolean).join(' ');
}

export async function runRuntimePreview({
  zip,
  signal,
  onUpdate,
  boot,
  prepare = prepareRuntimeProject,
}: RunRuntimePreviewOptions): Promise<void> {
  const logs = createRuntimeLogBuffer();
  const readers = new Set<ReadableStreamDefaultReader<string>>();
  const processes = new Set<WebContainerProcess>();
  const unsubscribers = new Set<() => void>();
  let lease: RuntimeLease | null = null;
  let phase: RuntimePreviewPhase = 'preparing';
  let url: string | null = null;
  let error: string | null = null;
  let cancelRun = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancelRun = () => reject(CANCELLED);
    signal.addEventListener('abort', cancelRun, { once: true });
  });

  const emit = () => {
    if (signal.aborted) return;
    onUpdate({
      phase,
      message: phase === 'failure' ? `Lỗi runtime: ${error}` : PHASE_MESSAGE[phase],
      logs: logs.snapshot(),
      url,
      error,
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
      while (!signal.aborted) {
        const result = await reader.read();
        if (result.done) return;
        logs.push(result.value);
        emit();
      }
    } catch (streamError) {
      if (!signal.aborted) throw streamError;
    } finally {
      readers.delete(reader);
      reader.releaseLock();
    }
  };

  emit();
  try {
    const project = prepare(zip);
    setPhase('booting');
    lease = await Promise.race([acquireRuntime(boot, signal), cancelled]);
    if (!lease) return;

    let rejectRuntimeError: (reason: unknown) => void = () => {};
    const runtimeError = new Promise<never>((_resolve, reject) => { rejectRuntimeError = reject; });
    unsubscribers.add(lease.container.on('error', (runtimeFailure) => {
      rejectRuntimeError(new Error(normalizeRuntimeError(runtimeFailure)));
    }));

    await Promise.race([lease.container.mount(project.files), runtimeError, cancelled]);

    setPhase('installing');
    const [installCommand, ...installArgs] = project.installCommand;
    const install = await Promise.race([
      lease.container.spawn(installCommand, installArgs, { cwd: project.workingDirectory }),
      runtimeError,
      cancelled,
    ]);
    processes.add(install);
    const installOutput = streamOutput(install);
    const installExit = await Promise.race([install.exit, runtimeError, cancelled]);
    await Promise.race([installOutput, runtimeError, cancelled]);
    if (installExit !== 0) {
      throw new Error(`${commandName(installCommand, installArgs)} exited with code ${installExit}.`);
    }

    setPhase('starting');
    let serverReady: (readyUrl: string) => void = () => {};
    const ready = new Promise<string>((resolve) => { serverReady = resolve; });
    unsubscribers.add(lease.container.on('server-ready', (_port, readyUrl) => serverReady(readyUrl)));

    const [devCommand, ...devArgs] = project.devCommand;
    const dev = await Promise.race([
      lease.container.spawn(devCommand, devArgs, { cwd: project.workingDirectory }),
      runtimeError,
      cancelled,
    ]);
    processes.add(dev);
    void streamOutput(dev).catch((streamError) => rejectRuntimeError(streamError));
    const devExit = dev.exit.then((exitCode) => {
      throw new Error(`${commandName(devCommand, devArgs)} exited with code ${exitCode}.`);
    });

    url = await Promise.race([ready, devExit, runtimeError, cancelled]);
    setPhase('ready');
    await Promise.race([devExit, runtimeError, cancelled]);
  } catch (runtimeFailure) {
    if (runtimeFailure !== CANCELLED && !signal.aborted) {
      phase = 'failure';
      error = normalizeRuntimeError(runtimeFailure);
      emit();
    }
  } finally {
    signal.removeEventListener('abort', cancelRun);
    for (const unsubscribe of unsubscribers) {
      try { unsubscribe(); } catch {}
    }
    for (const process of processes) {
      try { process.kill(); } catch {}
    }
    await Promise.allSettled([...readers].map((reader) => reader.cancel()));
    lease?.release();
  }
}
