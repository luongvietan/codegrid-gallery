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

/** Strip leading date, turn underscores into spaces, collapse whitespace. Mirrors build-index.mjs. */
export function prettyTitle(folder) {
  return folder.replace(/^\d{4}-\d{2}-\d{2}_/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Stable id from a folder name. Mirrors build-index.mjs. */
export function slug(folder) {
  return folder.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Choose a thumbnail filename: png first, then jpg/jpeg/webp, else the first image. */
export function pickThumbnail(images) {
  const png = images.find((i) => /\.png$/i.test(i.filename));
  const other = images.find((i) => /\.(jpe?g|webp)$/i.test(i.filename));
  return (png || other || images[0])?.filename || null;
}

/** Build one index project entry (same shape build-index.mjs produces). */
export function buildProjectEntry({ msg, folder, type, entryHtml, attachments }) {
  return {
    id: slug(folder),
    folder,
    title: prettyTitle(folder),
    type,
    date: (msg.timestamp || '').slice(0, 10) || null,
    author: msg.author?.username ?? null,
    msgId: msg.id,
    thumbnail: pickThumbnail(attachments.images),
    video: attachments.videos[0]?.filename ?? null,
    zip: attachments.zips[0]?.filename ?? null,
    entryHtml,
    media: { images: attachments.images, videos: attachments.videos, zips: attachments.zips },
  };
}

/** Set of msgIds already in the index. */
export function knownMsgIds(index) {
  return new Set((index.projects || []).map((p) => p.msgId).filter(Boolean));
}

/** Largest msgId (Discord snowflake) in the index, or null. */
export function newestMsgId(index) {
  let max = null;
  for (const p of index.projects || []) {
    if (!p.msgId || !/^\d+$/.test(p.msgId)) continue;
    if (max === null || BigInt(p.msgId) > BigInt(max)) max = p.msgId;
  }
  return max;
}

/** Merge new entries into the index: dedupe by id, sort by folder, recompute counts + generatedAt. */
export function mergeIndex(index, newEntries, now = new Date()) {
  const map = new Map((index.projects || []).map((p) => [p.id, p]));
  for (const e of newEntries) map.set(e.id, e);
  const projects = [...map.values()].sort((a, b) => a.folder.localeCompare(b.folder));
  const counts = projects.reduce((m, p) => ((m[p.type] = (m[p.type] || 0) + 1), m), {});
  return { generatedAt: now.toISOString(), counts, projects };
}
