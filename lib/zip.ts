import { proxiedAssetUrl } from './assets.ts';

interface ZipEntry {
  dir: boolean;
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

export async function fetchAndExtractZip(folder: string, zipName: string): Promise<ExtractedZip> {
  const response = await fetch(proxiedAssetUrl(folder, zipName));
  if (!response.ok) throw new Error(`Không tải được ZIP (HTTP ${response.status}).`);
  const buf = await response.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const names: string[] = [];
  const files = new Map<string, ArrayBuffer>();
  const jobs: Promise<void>[] = [];
  zip.forEach((rel, entry) => {
    if (entry.dir) return;
    if (rel.startsWith('__MACOSX/') || rel.endsWith('.DS_Store')) return;
    if (/(^|\/)(\.git|node_modules|\.next)\//.test(rel)) return;
    names.push(rel);
    jobs.push(entry.async('arraybuffer').then((ab: ArrayBuffer) => { files.set(rel, ab); }));
  });
  await Promise.all(jobs);
  names.sort();
  return { names, files };
}
