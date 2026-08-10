import type { DirectoryNode, FileSystemTree } from '@webcontainer/api';
import type { ExtractedZip } from './zip.ts';

export type { FileSystemTree } from '@webcontainer/api';

export interface RuntimeProject {
  files: FileSystemTree;
  workingDirectory: string;
  installCommand: string[];
  devCommand: string[];
}

export const RUNTIME_PROJECT_ERROR = 'Runtime project is invalid or unsupported.';
export const RUNTIME_UNSUPPORTED_NEXT_ERROR =
  'Template dùng Next.js 16 trở lên, chưa chạy được trong trình duyệt: Next.js 16 chỉ nạp được '
  + 'WASM bindings trong WebContainer và vỡ invariant nội bộ khi render. Xem tab Code hoặc chạy local.';

/** A template the browser runtime deliberately declines, as opposed to a malformed one. */
export class UnsupportedRuntimeError extends Error {}

const IGNORED_DIRECTORIES = new Set(['.git', '.next', 'node_modules']);
const PROTOTYPE_POLLUTING_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function nextRangeGuaranteesMajor16(range: string): boolean {
  const match = range.trim().match(
    /^(?:\^|~|>=)?\s*v?(\d+)(?:\.\d+)?(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  return match !== null && Number.parseInt(match[1], 10) >= 16;
}

function invalidProject(): never {
  throw new Error(RUNTIME_PROJECT_ERROR);
}

function safePath(name: string): string[] {
  if (
    typeof name !== 'string'
    || name.length === 0
    || name.includes('\0')
    || name.includes('\\')
    || name.startsWith('/')
    || /^[A-Za-z]:/.test(name)
  ) {
    return invalidProject();
  }

  const segments = name.split('/');
  if (segments.some((segment) => (
    segment.length === 0
    || segment === '.'
    || segment === '..'
    || PROTOTYPE_POLLUTING_SEGMENTS.has(segment.toLowerCase())
  ))) {
    return invalidProject();
  }
  return segments;
}

function isIgnoredPath(segments: string[]): boolean {
  return segments.some((segment) => IGNORED_DIRECTORIES.has(segment.toLowerCase()));
}

function sourceEntries(zip: ExtractedZip): Array<{ name: string; segments: string[]; contents: ArrayBuffer }> {
  if (!zip || !Array.isArray(zip.names) || !(zip.files instanceof Map)) return invalidProject();

  const entries: Array<{ name: string; segments: string[]; contents: ArrayBuffer }> = [];
  const seen = new Set<string>();
  for (const name of zip.names) {
    const segments = safePath(name);
    if (seen.has(name)) return invalidProject();
    seen.add(name);
    const contents = zip.files.get(name);
    if (!(contents instanceof ArrayBuffer)) return invalidProject();
    if (!isIgnoredPath(segments)) entries.push({ name, segments, contents });
  }
  return entries;
}

function manifestEntry(entries: Array<{ name: string; segments: string[]; contents: ArrayBuffer }>) {
  return entries
    .filter((entry) => entry.segments.at(-1) === 'package.json')
    .sort((left, right) => left.segments.length - right.segments.length || left.name.localeCompare(right.name))[0];
}

function packageManifest(contents: ArrayBuffer): {
  scripts: Record<string, string>;
  packageManager: string | null;
  hasNextDependency: boolean;
  needsUnsupportedNext: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(contents));
  } catch {
    return invalidProject();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalidProject();

  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return invalidProject();

  const validScripts = Object.entries(scripts).filter((entry): entry is [string, string] => (
    typeof entry[1] === 'string' && entry[1].trim().length > 0
  ));
  const packageManager = (parsed as { packageManager?: unknown }).packageManager;
  const dependencies = (parsed as { dependencies?: unknown }).dependencies;
  const devDependencies = (parsed as { devDependencies?: unknown }).devDependencies;
  const nextVersion = [dependencies, devDependencies]
    .map((group) => (
      !!group && typeof group === 'object' && !Array.isArray(group)
        ? (group as Record<string, unknown>).next
        : null
    ))
    .find((version): version is string => typeof version === 'string') ?? null;
  return {
    scripts: Object.fromEntries(validScripts),
    packageManager: typeof packageManager === 'string' ? packageManager : null,
    hasNextDependency: nextVersion !== null,
    needsUnsupportedNext: nextVersion !== null && nextRangeGuaranteesMajor16(nextVersion),
  };
}

function isDirectory(entry: FileSystemTree[string]): entry is DirectoryNode {
  return 'directory' in entry;
}

function buildFileTree(entries: Array<{ segments: string[]; contents: ArrayBuffer }>): FileSystemTree {
  const tree: FileSystemTree = Object.create(null) as FileSystemTree;
  for (const entry of entries) {
    let directory = tree;
    for (const segment of entry.segments.slice(0, -1)) {
      const current = directory[segment];
      if (!current) {
        const child: DirectoryNode = { directory: Object.create(null) as FileSystemTree };
        directory[segment] = child;
        directory = child.directory;
      } else if (isDirectory(current)) {
        directory = current.directory;
      } else {
        return invalidProject();
      }
    }

    const fileName = entry.segments.at(-1);
    if (!fileName || directory[fileName]) return invalidProject();
    directory[fileName] = { file: { contents: new Uint8Array(entry.contents.slice(0)) } };
  }
  return tree;
}

function commandsFor(
  root: string,
  names: string[],
  pkg: ReturnType<typeof packageManifest>,
): Pick<RuntimeProject, 'installCommand' | 'devCommand'> {
  const hasPnpmLock = names.includes(`${root}pnpm-lock.yaml`);
  const hasNpmLock = names.includes(`${root}package-lock.json`) || names.includes(`${root}npm-shrinkwrap.json`);
  const usesPnpm = hasPnpmLock || pkg.packageManager?.startsWith('pnpm@');
  const scriptName = pkg.scripts.dev ? 'dev' : pkg.scripts.start ? 'start' : null;
  if (!scriptName) return invalidProject();

  const isNextDev = pkg.hasNextDependency && scriptName === 'dev';
  const serverArgs = isNextDev || /(?:^|\s)next\s+(?:dev|start)(?:\s|$)/.test(pkg.scripts[scriptName])
    ? ['--hostname', '0.0.0.0']
    : [];
  if (usesPnpm) {
    return {
      installCommand: hasPnpmLock
        ? ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']
        : ['corepack', 'pnpm', 'install', '--ignore-scripts'],
      devCommand: ['corepack', 'pnpm', scriptName, ...serverArgs],
    };
  }

  return {
    installCommand: hasNpmLock
      ? ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']
      : ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
    devCommand: ['npm', 'run', scriptName, ...(serverArgs.length ? ['--', ...serverArgs] : [])],
  };
}

export function prepareRuntimeProject(zip: ExtractedZip): RuntimeProject {
  try {
    const entries = sourceEntries(zip);
    const manifest = manifestEntry(entries);
    if (!manifest) return invalidProject();
    const pkg = packageManifest(manifest.contents);
    // Next 16 only loads WASM SWC bindings inside WebContainer and then breaks its own
    // workStore invariant while rendering — in dev and in a production build alike. Decline
    // before booting instead of spending an install on a runtime that can only serve errors.
    if (pkg.needsUnsupportedNext) throw new UnsupportedRuntimeError(RUNTIME_UNSUPPORTED_NEXT_ERROR);
    const root = manifest.segments.slice(0, -1).join('/');
    const rootPrefix = root ? `${root}/` : '';
    const commands = commandsFor(rootPrefix, entries.map((entry) => entry.name), pkg);

    return {
      files: buildFileTree(entries),
      workingDirectory: root,
      ...commands,
    };
  } catch (error) {
    if (error instanceof UnsupportedRuntimeError) throw error;
    return invalidProject();
  }
}
