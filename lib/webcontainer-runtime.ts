import type { ExtractedZip } from './zip.ts';

export interface RuntimeFile {
  file: Uint8Array;
}

export interface RuntimeDirectory {
  directory: FileSystemTree;
}

export interface FileSystemTree {
  [name: string]: RuntimeFile | RuntimeDirectory;
}

export interface RuntimeProject {
  files: FileSystemTree;
  workingDirectory: string;
  installCommand: string[];
  devCommand: string[];
}

export const RUNTIME_PROJECT_ERROR = 'Runtime project is invalid or unsupported.';

const IGNORED_DIRECTORIES = new Set(['.git', '.next', 'node_modules']);
const PROTOTYPE_POLLUTING_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

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
    .filter((entry) => entry.segments.at(-1)?.toLowerCase() === 'package.json')
    .sort((left, right) => left.segments.length - right.segments.length || left.name.localeCompare(right.name))[0];
}

function packageManifest(contents: ArrayBuffer): { scripts: Record<string, string> } {
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
  return { scripts: Object.fromEntries(validScripts) };
}

function isDirectory(entry: RuntimeFile | RuntimeDirectory): entry is RuntimeDirectory {
  return 'directory' in entry;
}

function buildFileTree(entries: Array<{ segments: string[]; contents: ArrayBuffer }>): FileSystemTree {
  const tree: FileSystemTree = Object.create(null) as FileSystemTree;
  for (const entry of entries) {
    let directory = tree;
    for (const segment of entry.segments.slice(0, -1)) {
      const current = directory[segment];
      if (!current) {
        const child: RuntimeDirectory = { directory: Object.create(null) as FileSystemTree };
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
    directory[fileName] = { file: new Uint8Array(entry.contents.slice(0)) };
  }
  return tree;
}

function commandsFor(root: string, names: string[], scripts: Record<string, string>): Pick<RuntimeProject, 'installCommand' | 'devCommand'> {
  const hasPnpmLock = names.includes(`${root}pnpm-lock.yaml`);
  const hasNpmLock = names.includes(`${root}package-lock.json`) || names.includes(`${root}npm-shrinkwrap.json`);
  const scriptName = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
  if (!scriptName) return invalidProject();

  const serverArgs = /(?:^|\s)next\s+(?:dev|start)(?:\s|$)/.test(scripts[scriptName])
    ? ['--hostname', '0.0.0.0']
    : [];
  if (hasPnpmLock) {
    return {
      installCommand: ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'],
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
    const root = manifest.segments.slice(0, -1).join('/');
    const rootPrefix = root ? `${root}/` : '';
    const commands = commandsFor(rootPrefix, entries.map((entry) => entry.name), pkg.scripts);

    return {
      files: buildFileTree(entries),
      workingDirectory: root,
      ...commands,
    };
  } catch {
    return invalidProject();
  }
}
