// scripts/sync-lib.mjs
// Pure helpers for the daily CI sync. No I/O — unit-tested in sync-lib.test.mjs.

/** Replace filesystem-invalid characters with '_', then trim. Mirrors download_codegrid.py. */
export function sanitizeFilename(name) {
  return name.replace(/[<>:"\/\\|?*]/g, '_').trim();
}

/** Build the per-post folder name: `${date}_${sanitized 60-char bold title}` (or `${date}_${id}`). */
export function folderNameForMessage(msg) {
  const content = msg.content || '';
  const m = content.match(/\*\*(.+?)\*\*/);
  const rawTitle = m ? m[1] : '';
  const title = rawTitle ? sanitizeFilename(rawTitle.slice(0, 60)) : '';
  const date = (msg.timestamp || '').slice(0, 10) || 'unknown';
  return title ? `${date}_${title}` : `${date}_${msg.id}`;
}

/** Split a message's attachments into { zips, images, videos } of { url, filename, size }. */
export function extractAttachments(msg) {
  const zips = [], images = [], videos = [];
  for (const att of msg.attachments || []) {
    const rec = { url: att.url || '', filename: att.filename || '', size: att.size || 0 };
    const lower = rec.filename.toLowerCase();
    const ct = att.content_type || '';
    if (lower.endsWith('.zip') || ct.includes('zip')) zips.push(rec);
    else if (/\.(mp4|mov|webm|avi|mkv)$/.test(lower) || ct.startsWith('video/')) videos.push(rec);
    else if (/\.(jpg|jpeg|png|gif|webp|bmp)$/.test(lower) || ct.startsWith('image/')) images.push(rec);
  }
  return { zips, images, videos };
}

/** Read filenames from a zip Buffer via its End-Of-Central-Directory record (no decompression). */
export function listZipEntries(buf) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  const CEN = 0x02014b50;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(off) !== CEN) break;
    const nLen = buf.readUInt16LE(off + 28);
    const eLen = buf.readUInt16LE(off + 30);
    const cLen = buf.readUInt16LE(off + 32);
    names.push(buf.toString('utf8', off + 46, off + 46 + nLen));
    off += 46 + nLen + eLen + cLen;
  }
  return names;
}

/** Classify a zip's file list into 'nextjs' | 'react' | 'html'. Mirrors build-index.mjs. */
export function classify(names) {
  const real = names.map((n) => n.toLowerCase()).filter((n) => !n.startsWith('__macosx/'));
  if (real.some((n) => /(^|\/)next\.config\.(js|mjs|ts|cjs)$/.test(n))) return 'nextjs';
  if (real.some((n) => /(^|\/)package\.json$/.test(n))) return 'react';
  return 'html';
}

/** Pick the entry HTML file (shallowest index.html, else shallowest .html, else null). */
export function pickEntryHtml(names) {
  const byDepth = (a, b) => a.split('/').length - b.split('/').length || a.length - b.length;
  const index = names.filter((n) => !n.startsWith('__MACOSX/') && /(^|\/)index\.html$/i.test(n));
  if (index.length) return index.sort(byDepth)[0];
  const any = names.filter((n) => !n.startsWith('__MACOSX/') && /\.html$/i.test(n));
  return any.length ? any.sort(byDepth)[0] : null;
}
