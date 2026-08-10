import { proxiedAssetUrl } from './assets.ts';

interface ZipEntry {
  dir: boolean;
  _data?: { uncompressedSize?: number };
  async(type: 'arraybuffer'): Promise<ArrayBuffer>;
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

const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const ZIP_SAFETY_ERROR = 'ZIP vượt quá giới hạn an toàn.';

function safetyError(): never {
  throw new Error(ZIP_SAFETY_ERROR);
}

function includedSourcePath(relativePath: string): boolean {
  return !relativePath.startsWith('__MACOSX/')
    && !relativePath.endsWith('.DS_Store')
    && !/(^|\/)(\.git|node_modules|\.next)\//.test(relativePath);
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
      if (declaredExpandedBytes > MAX_EXPANDED_BYTES) return safetyError();
    }
    entries.push({ relativePath, entry });
  });

  const names: string[] = [];
  const files = new Map<string, ArrayBuffer>();
  let expandedBytes = 0;
  for (const { relativePath, entry } of entries) {
    const contents = await entry.async('arraybuffer');
    if (contents.byteLength > MAX_FILE_BYTES) return safetyError();
    expandedBytes += contents.byteLength;
    if (expandedBytes > MAX_EXPANDED_BYTES) return safetyError();
    names.push(relativePath);
    files.set(relativePath, contents);
  }
  names.sort();
  return { names, files };
}
