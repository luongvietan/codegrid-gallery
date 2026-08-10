import { proxiedAssetUrl } from './assets.ts';

interface ZipEntry {
  dir: boolean;
  _data?: { uncompressedSize?: number };
  internalStream(type: 'uint8array'): ZipStream;
}

interface ZipStream {
  on(event: 'data', callback: (chunk: Uint8Array) => void): ZipStream;
  on(event: 'end', callback: () => void): ZipStream;
  on(event: 'error', callback: (error: Error) => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
}

interface ZipArchive {
  forEach(callback: (relativePath: string, entry: ZipEntry) => void): void;
}

// JSZip is loaded globally via /jszip.min.js
declare const JSZip: {
  loadAsync(data: ArrayBuffer): Promise<ZipArchive>;
};

export interface ExtractedZip {
  names: string[];
  files: Map<string, ArrayBuffer>;
}

// Sized against the real gallery: the largest published archive is ~120 MB compressed and
// several media-heavy templates carry single video files well past 16 MB. The expanded budget
// stays adaptive so a small archive still cannot expand into a zip bomb.
const MAX_COMPRESSED_BYTES = 192 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MIN_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_EXPANSION_RATIO = 20;
const ZIP_SAFETY_ERROR = 'ZIP vượt quá giới hạn an toàn.';

export const ZIP_LIMITS = {
  maxCompressedBytes: MAX_COMPRESSED_BYTES,
  maxArchiveEntries: MAX_ARCHIVE_ENTRIES,
  maxFileBytes: MAX_FILE_BYTES,
  maxExpandedBytes: MAX_EXPANDED_BYTES,
  minExpandedBytes: MIN_EXPANDED_BYTES,
  maxExpansionRatio: MAX_EXPANSION_RATIO,
} as const;

/** Expanded output allowed for an archive of this compressed size. */
export function expandedBudget(compressedBytes: number): number {
  const ratioBudget = Math.max(MIN_EXPANDED_BYTES, compressedBytes * MAX_EXPANSION_RATIO);
  return Math.min(MAX_EXPANDED_BYTES, ratioBudget);
}

function safetyError(): never {
  throw new Error(ZIP_SAFETY_ERROR);
}

function includedSourcePath(relativePath: string): boolean {
  return !relativePath.startsWith('__MACOSX/')
    && !relativePath.endsWith('.DS_Store')
    && !/(^|\/)(\.git|node_modules|\.next)\//.test(relativePath);
}

function extractBounded(
  entry: ZipEntry,
  previouslyExpandedBytes: number,
  budget: number,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let fileBytes = 0;
    let settled = false;
    const stream = entry.internalStream('uint8array');

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.pause();
      reject(error);
    };

    stream
      .on('data', (chunk) => {
        if (settled) return;
        fileBytes += chunk.byteLength;
        if (fileBytes > MAX_FILE_BYTES || previouslyExpandedBytes + fileBytes > budget) {
          rejectOnce(new Error(ZIP_SAFETY_ERROR));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', rejectOnce)
      .on('end', () => {
        if (settled) return;
        settled = true;
        if (chunks.length === 1 && chunks[0].byteOffset === 0
          && chunks[0].byteLength === chunks[0].buffer.byteLength
          && chunks[0].buffer instanceof ArrayBuffer) {
          resolve(chunks[0].buffer);
          return;
        }

        const contents = new Uint8Array(fileBytes);
        let offset = 0;
        for (const chunk of chunks) {
          contents.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(contents.buffer);
      })
      .resume();
  });
}

async function readCompressedZip(response: Response): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const contents = await response.arrayBuffer();
    if (contents.byteLength > MAX_COMPRESSED_BYTES) return safetyError();
    return contents;
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_COMPRESSED_BYTES) {
        try { await reader.cancel(); } catch { /* The safety rejection still takes precedence. */ }
        return safetyError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const contents = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    contents.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return contents.buffer;
}

export async function fetchAndExtractZip(folder: string, zipName: string): Promise<ExtractedZip> {
  const response = await fetch(proxiedAssetUrl(folder, zipName));
  if (!response.ok) throw new Error(`Không tải được ZIP (HTTP ${response.status}).`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_COMPRESSED_BYTES) return safetyError();
  const buf = await readCompressedZip(response);
  const budget = expandedBudget(buf.byteLength);
  const zip = await JSZip.loadAsync(buf);
  const entries: Array<{ relativePath: string; entry: ZipEntry }> = [];
  let entryCount = 0;
  let declaredExpandedBytes = 0;
  zip.forEach((relativePath, entry) => {
    entryCount += 1;
    if (entryCount > MAX_ARCHIVE_ENTRIES) return safetyError();
    if (entry.dir || !includedSourcePath(relativePath)) return;

    const declaredSize = entry._data?.uncompressedSize;
    if (declaredSize !== undefined) {
      if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_FILE_BYTES) {
        return safetyError();
      }
      declaredExpandedBytes += declaredSize;
      if (declaredExpandedBytes > budget) return safetyError();
    }
    entries.push({ relativePath, entry });
  });

  const names: string[] = [];
  const files = new Map<string, ArrayBuffer>();
  let expandedBytes = 0;
  for (const { relativePath, entry } of entries) {
    const contents = await extractBounded(entry, expandedBytes, budget);
    expandedBytes += contents.byteLength;
    names.push(relativePath);
    files.set(relativePath, contents);
  }
  names.sort();
  return { names, files };
}
