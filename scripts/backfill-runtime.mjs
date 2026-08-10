// Backfills the real runtime of every published template into data/index.json.
//
// The gallery originally recorded only a coarse `type`, which folded every build-tool project
// into "react". Classifying properly needs each archive's package.json, but the archives total
// gigabytes — so this reads them over HTTP range requests: the tail, the central directory, and
// the one manifest record. The archive is reassembled sparsely at its true offsets, which lets
// the regular classifier parse it exactly as it would a fully downloaded file.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  inspectTemplateArchive,
  packageRecord,
  projectTypeForRuntime,
  readCentralDirectoryRecords,
} from './preview-classifier.mjs';

const EOCD_SIGNATURE = 0x06054b50;
const MAX_EOCD_COMMENT = 65_535;
const EOCD_MIN_SIZE = 22;
const TAIL_BYTES = EOCD_MIN_SIZE + MAX_EOCD_COMMENT;
/** Local headers carry a variable extra field; overshoot rather than round-trip for its length. */
const LOCAL_HEADER_SLACK = 4_096;
const DEFAULT_ASSET_BASE = 'https://pub-2c8291ac249e456c8e906fe5f4aed9c9.r2.dev';

export function entriesNeedingRuntime(projects, limit = Infinity) {
  return projects.filter((project) => project?.zip && !project.runtime).slice(0, limit);
}

/**
 * Realign the legacy `type` with the measured runtime. Preview routing still keys off `type`, so
 * a project the old filename heuristics mislabelled would otherwise open the wrong preview.
 */
export function realignTypes(projects) {
  const corrections = [];
  for (const project of projects) {
    if (!project?.runtime) continue;
    const type = projectTypeForRuntime(project.runtime);
    if (project.type === type) continue;
    corrections.push({ folder: project.folder, from: project.type, to: type, runtime: project.runtime });
    project.type = type;
  }
  return corrections;
}

export function typeCounts(projects) {
  const counts = {};
  for (const project of projects) {
    if (!project?.type) continue;
    counts[project.type] = (counts[project.type] || 0) + 1;
  }
  return counts;
}

export function runtimeCounts(projects) {
  const counts = {};
  for (const project of projects) {
    const key = project?.runtime || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function assetUrl(folder, filename, base = process.env.NEXT_PUBLIC_ASSET_BASE || DEFAULT_ASSET_BASE) {
  const encode = (value) => value.split('/').map(encodeURIComponent).join('/');
  return `${base.replace(/\/+$/, '')}/${encode(folder)}/${encode(filename)}`;
}

/** `range` is either {suffix} for the last N bytes or {start, end} for an inclusive window. */
export async function httpRange(url, range) {
  const header = range.suffix !== undefined ? `bytes=-${range.suffix}` : `bytes=${range.start}-${range.end}`;
  const response = await fetch(url, { headers: { range: header } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const contentRange = response.headers.get('content-range');
  const totalSize = contentRange ? Number(contentRange.split('/')[1]) : null;
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) throw new Error(`Missing content-range for ${url}`);
  return { body: Buffer.from(await response.arrayBuffer()), totalSize };
}

/** Locate the end-of-central-directory record inside an archive tail. */
function centralDirectoryBounds(tail, tailStart, totalSize) {
  for (let offset = tail.length - EOCD_MIN_SIZE; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (tailStart + offset + EOCD_MIN_SIZE + commentLength !== totalSize) continue;
    return { offset: tail.readUInt32LE(offset + 16), size: tail.readUInt32LE(offset + 12) };
  }
  throw new Error('ZIP end-of-central-directory record not found in archive tail');
}

/**
 * Read just enough of a remote archive to classify it, then hand the sparse buffer to the
 * regular inspector so archive validation stays in one place.
 */
export async function inspectRemoteArchive(url, fetchRange = httpRange) {
  const tail = await fetchRange(url, { suffix: TAIL_BYTES });
  const totalSize = tail.totalSize;
  const tailStart = totalSize - tail.body.length;
  const archive = Buffer.alloc(totalSize);
  tail.body.copy(archive, tailStart);

  const bounds = centralDirectoryBounds(tail.body, tailStart, totalSize);
  if (bounds.offset < tailStart) {
    const directory = await fetchRange(url, { start: bounds.offset, end: bounds.offset + bounds.size - 1 });
    directory.body.copy(archive, bounds.offset);
  }

  const manifest = packageRecord(readCentralDirectoryRecords(archive));
  if (manifest && manifest.localHeaderOffset < tailStart) {
    const start = manifest.localHeaderOffset;
    const end = Math.min(
      totalSize - 1,
      start + 30 + manifest.name.length + LOCAL_HEADER_SLACK + manifest.compressedSize,
    );
    const record = await fetchRange(url, { start, end });
    record.body.copy(archive, start);
  }

  return inspectTemplateArchive(archive);
}

function parseArgs(argv) {
  const limit = argv.find((arg) => arg.startsWith('--limit='));
  return {
    limit: limit ? Number(limit.split('=')[1]) : Infinity,
    dryRun: argv.includes('--dry-run'),
    indexPath: argv.find((arg) => arg.startsWith('--index='))?.split('=')[1] || 'data/index.json',
  };
}

async function main() {
  const { limit, dryRun, indexPath } = parseArgs(process.argv.slice(2));
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const pending = entriesNeedingRuntime(index.projects, limit);
  console.log(`${pending.length} of ${index.projects.length} projects still need a runtime.`);

  let failures = 0;
  for (const [position, project] of pending.entries()) {
    const url = assetUrl(project.folder, project.zip);
    try {
      const inspection = await inspectRemoteArchive(url);
      project.runtime = inspection.runtime;
      console.log(`[${position + 1}/${pending.length}] ${inspection.runtime.padEnd(13)} ${project.folder}`);
    } catch (error) {
      failures += 1;
      console.warn(`[${position + 1}/${pending.length}] FAILED       ${project.folder}: ${error.message}`);
    }
  }

  for (const correction of realignTypes(index.projects)) {
    console.log(`type ${correction.from} → ${correction.to} (${correction.runtime}) ${correction.folder}`);
  }
  index.counts = typeCounts(index.projects);
  console.log('Runtime distribution:', runtimeCounts(index.projects));
  if (failures) console.warn(`${failures} archive(s) could not be classified and keep their previous data.`);
  if (dryRun) {
    console.log('Dry run: data/index.json left untouched.');
    return;
  }
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`Wrote ${indexPath}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
