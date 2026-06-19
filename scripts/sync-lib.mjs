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
