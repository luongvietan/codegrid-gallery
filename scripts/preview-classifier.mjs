import { inflateRawSync } from 'node:zlib';

export const RUNTIMES = ['html', 'vite-vanilla', 'vite-react', 'cra', 'nextjs', 'unsupported'];

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_EXPANDED_BYTES = 750 * 1024 * 1024;
const UNIX_HOST_OS = 3;
const DIRECTORY_MODE_MASK = 0o170000;
const SYMBOLIC_LINK_MODE = 0o120000;

function inBounds(buffer, offset, length) {
  return Number.isSafeInteger(offset)
    && Number.isSafeInteger(length)
    && offset >= 0
    && length >= 0
    && offset <= buffer.length
    && length <= buffer.length - offset;
}

function findEndOfCentralDirectory(zipBuffer) {
  for (let offset = zipBuffer.length - 22; offset >= 0 && offset >= zipBuffer.length - 22 - 65_535; offset--) {
    if (zipBuffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('ZIP end-of-central-directory record not found');
}

function readCentralDirectoryRecords(zipBuffer) {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length < 22) throw new Error('Invalid ZIP archive');
  const eocdOffset = findEndOfCentralDirectory(zipBuffer);
  const entryCount = zipBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  if (!inBounds(zipBuffer, centralDirectoryOffset, centralDirectorySize)) throw new Error('Invalid ZIP central directory bounds');
  if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error(`ZIP archive has too many entries (maximum ${MAX_ARCHIVE_ENTRIES})`);

  const records = [];
  let offset = centralDirectoryOffset;
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  for (let index = 0; index < entryCount; index++) {
    if (!inBounds(zipBuffer, offset, 46) || offset + 46 > centralDirectoryEnd) throw new Error('Invalid ZIP central directory entry');
    if (zipBuffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) throw new Error('Invalid ZIP central directory signature');
    const versionMadeBy = zipBuffer.readUInt16LE(offset + 4);
    const compressionMethod = zipBuffer.readUInt16LE(offset + 10);
    const compressedSize = zipBuffer.readUInt32LE(offset + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 24);
    const nameLength = zipBuffer.readUInt16LE(offset + 28);
    const extraLength = zipBuffer.readUInt16LE(offset + 30);
    const commentLength = zipBuffer.readUInt16LE(offset + 32);
    const externalAttributes = zipBuffer.readUInt32LE(offset + 38);
    const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (!inBounds(zipBuffer, offset, recordLength) || offset + recordLength > centralDirectoryEnd) throw new Error('Invalid ZIP central directory entry length');

    records.push({
      name: zipBuffer.toString('utf8', offset + 46, offset + 46 + nameLength),
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      unixMode: (versionMadeBy >>> 8) === UNIX_HOST_OS ? externalAttributes >>> 16 : 0,
    });
    offset += recordLength;
  }
  return records;
}

export function validateArchiveRecords(records) {
  if (!Array.isArray(records)) throw new Error('ZIP archive records must be an array');
  if (records.length > MAX_ARCHIVE_ENTRIES) throw new Error(`ZIP archive has too many entries (maximum ${MAX_ARCHIVE_ENTRIES})`);

  let expandedBytes = 0;
  for (const record of records) {
    const name = record?.name;
    if (typeof name !== 'string' || name.length === 0 || name.includes('\0') || name.includes('\\')
      || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
      throw new Error(`Unsafe path in ZIP archive: ${JSON.stringify(name)}`);
    }
    if ((record.unixMode & DIRECTORY_MODE_MASK) === SYMBOLIC_LINK_MODE) throw new Error(`Symbolic link in ZIP archive: ${name}`);
    if (!Number.isSafeInteger(record.uncompressedSize) || record.uncompressedSize < 0) throw new Error(`Invalid expanded size in ZIP archive: ${name}`);
    expandedBytes += record.uncompressedSize;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error(`ZIP archive expanded size exceeds ${MAX_EXPANDED_BYTES} bytes`);
  }
}

export function classifyRuntime(names, pkg) {
  if (!pkg) return names.some((name) => /(^|\/)index\.html$/i.test(name)) ? 'html' : 'unsupported';
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (deps.next) return 'nextjs';
  if (deps['react-scripts']) return 'cra';
  if (deps.vite) return deps.react || deps['@vitejs/plugin-react'] ? 'vite-react' : 'vite-vanilla';
  return 'unsupported';
}

export function projectTypeForRuntime(runtime) {
  if (runtime === 'nextjs') return 'nextjs';
  if (runtime === 'html') return 'html';
  return 'react';
}

function archiveRoot(name) {
  const separator = name.lastIndexOf('/');
  return separator < 0 ? '' : name.slice(0, separator + 1);
}

function shallowestRecord(records, predicate) {
  return records
    .filter(predicate)
    .sort((left, right) => left.name.split('/').length - right.name.split('/').length || left.name.length - right.name.length)[0] || null;
}

function packageRecord(records) {
  return shallowestRecord(records, (record) => /(^|\/)package\.json$/i.test(record.name)
    && !record.name.split('/').some((segment) => segment.toLowerCase() === 'node_modules'));
}

function readRecordContents(zipBuffer, record) {
  const offset = record.localHeaderOffset;
  if (!inBounds(zipBuffer, offset, 30) || zipBuffer.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) throw new Error(`Invalid ZIP local header for ${record.name}`);
  const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
  const nameLength = zipBuffer.readUInt16LE(offset + 26);
  const extraLength = zipBuffer.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  if (compressionMethod !== record.compressionMethod || !inBounds(zipBuffer, dataOffset, record.compressedSize)) {
    throw new Error(`Invalid ZIP data for ${record.name}`);
  }
  const compressed = zipBuffer.subarray(dataOffset, dataOffset + record.compressedSize);
  let contents;
  if (record.compressionMethod === 0) contents = compressed;
  else if (record.compressionMethod === 8) {
    try {
      contents = inflateRawSync(compressed, { maxOutputLength: record.uncompressedSize });
    } catch {
      throw new Error(`ZIP data expanded size is invalid for ${record.name}`);
    }
  } else throw new Error(`Unsupported ZIP compression method for ${record.name}`);
  if (contents.length !== record.uncompressedSize) throw new Error(`ZIP data expanded size is invalid for ${record.name}`);
  return contents;
}

function dependencyVersion(pkg, runtime) {
  const dependencyName = runtime === 'nextjs' ? 'next'
    : runtime === 'cra' ? 'react-scripts'
      : runtime === 'vite-vanilla' || runtime === 'vite-react' ? 'vite'
        : null;
  if (!dependencyName) return null;
  return pkg?.dependencies?.[dependencyName] ?? pkg?.devDependencies?.[dependencyName] ?? null;
}

function commandsFor(runtime, packageManager, names, root, pkg) {
  const installCommand = packageManager === 'pnpm'
    ? ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']
    : names.includes(`${root}package-lock.json`)
      ? ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']
      : ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'];
  const devCommand = pkg?.scripts?.dev
    ? packageManager === 'pnpm' ? ['corepack', 'pnpm', 'dev'] : ['npm', 'run', 'dev']
    : pkg?.scripts?.start
      ? packageManager === 'pnpm' ? ['corepack', 'pnpm', 'start'] : ['npm', 'start']
      : null;
  const buildCommand = runtime === 'vite-vanilla' || runtime === 'vite-react'
    ? ['npx', '--no-install', 'vite', 'build', '--base=./']
    : runtime === 'cra'
      ? ['npm', 'run', 'build']
      : null;
  return { installCommand, devCommand, buildCommand };
}

export function inspectTemplateArchive(zipBuffer) {
  const records = readCentralDirectoryRecords(zipBuffer);
  validateArchiveRecords(records);
  const names = records.map((record) => record.name);
  const manifest = packageRecord(records);
  const root = manifest ? archiveRoot(manifest.name) : archiveRoot(shallowestRecord(records, (record) => /(^|\/)index\.html$/i.test(record.name))?.name || '');
  const pkg = manifest ? JSON.parse(readRecordContents(zipBuffer, manifest).toString('utf8')) : null;
  const runtime = classifyRuntime(names, pkg);
  const packageManager = names.some((name) => name === `${root}pnpm-lock.yaml`) ? 'pnpm' : 'npm';
  const { installCommand, devCommand, buildCommand } = commandsFor(runtime, packageManager, names, root, pkg);

  return {
    names,
    records,
    root,
    runtime,
    packageManager,
    installCommand,
    devCommand,
    buildCommand,
    frameworkVersion: dependencyVersion(pkg, runtime),
  };
}
