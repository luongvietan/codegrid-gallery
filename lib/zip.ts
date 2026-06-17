import { assetUrl } from './assets';

// JSZip is loaded globally via /jszip.min.js
declare const JSZip: any;

export interface ExtractedZip {
  names: string[];
  files: Map<string, ArrayBuffer>;
}

export async function fetchAndExtractZip(folder: string, zipName: string): Promise<ExtractedZip> {
  const buf = await (await fetch(assetUrl(folder, zipName))).arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const names: string[] = [];
  const files = new Map<string, ArrayBuffer>();
  const jobs: Promise<void>[] = [];
  zip.forEach((rel: string, entry: any) => {
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
