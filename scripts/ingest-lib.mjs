// scripts/ingest-lib.mjs
// Pure helpers for the code-ingest harness ("learn 100% of the gallery code").
// No network / no filesystem — every function here is unit-tested in ingest-lib.test.mjs.
// Style mirrors sync-lib.mjs: small, dependency-free, hand-rolled zip parsing.
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// R2 URL building — mirrors lib/assets.ts so the harness fetches the exact same
// objects the browser gallery does: `${BASE}/${folder}/${filename}` (per-segment
// encodeURIComponent).
// ---------------------------------------------------------------------------
export function encodePath(s) {
  return String(s).split('/').map(encodeURIComponent).join('/');
}

export function zipUrl(base, folder, filename) {
  const b = String(base || '').replace(/\/+$/, '');
  return `${b}/${encodePath(folder)}/${encodePath(filename)}`;
}

// ---------------------------------------------------------------------------
// File classification — which entries are "code we learn" vs. binary/junk.
// TEXT_EXT is a superset of components/tabs/CodeTab.tsx (the gallery's own code
// viewer) plus the extra source formats that show up across 422 community zips.
// ---------------------------------------------------------------------------
export const TEXT_EXT = new Set([
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'astro', 'svelte',
  'json', 'jsonc', 'md', 'mdx', 'txt', 'svg', 'xml', 'yml', 'yaml', 'toml',
  'glsl', 'frag', 'vert', 'shader', 'csv', 'graphql', 'gql',
  'gitignore', 'env', 'config', 'map', 'babelrc', 'eslintrc', 'prettierrc',
  'editorconfig', 'htaccess', 'lock', 'sample', 'rscinfo', 'old',
  'license', 'readme',
]);

// Directories that are never "the code you learn" — deps, build output, VCS,
// macOS cruft. Mirrors the skip logic in lib/zip.ts, extended for node projects.
export const SKIP_DIR_RE =
  /(^|\/)(\.git|node_modules|\.next|\.cache|\.turbo|\.parcel-cache|dist|build|out|coverage|\.vercel)\//;

export function isJunkPath(name) {
  const n = String(name);
  return n.startsWith('__MACOSX/') || n.endsWith('.DS_Store') || SKIP_DIR_RE.test(n);
}

/** Last extension of a path, lowercased. Dot-files (".env", ".gitignore") and
 *  extensionless names ("README", "LICENSE") resolve to the whole basename. */
export function extOf(name) {
  const base = String(name).split('/').pop() || '';
  if (base.startsWith('.')) return base.slice(1).toLowerCase();
  if (!base.includes('.')) return base.toLowerCase();
  return base.split('.').pop().toLowerCase();
}

export function isTextFile(name) {
  return TEXT_EXT.has(extOf(name));
}

const LANG_BY_EXT = {
  html: 'HTML', htm: 'HTML',
  css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less', styl: 'Stylus',
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX',
  vue: 'Vue', astro: 'Astro', svelte: 'Svelte',
  json: 'JSON', jsonc: 'JSON', md: 'Markdown', mdx: 'Markdown',
  svg: 'SVG', xml: 'XML', yml: 'YAML', yaml: 'YAML', toml: 'TOML',
  glsl: 'GLSL', frag: 'GLSL', vert: 'GLSL', shader: 'GLSL',
  graphql: 'GraphQL', gql: 'GraphQL', csv: 'Data', txt: 'Text',
};

export function langOf(name) {
  return LANG_BY_EXT[extOf(name)] || 'Other';
}

// ---------------------------------------------------------------------------
// Path safety — never let a zip entry escape its corpus/<id>/ directory
// (zip-slip). Returns a normalized forward-slash relative path, or null if the
// entry is absolute or contains a `..` segment.
// ---------------------------------------------------------------------------
export function safeRelPath(name) {
  const norm = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.endsWith('/')) return null;
  if (/(^|\/)\.\.(\/|$)/.test(norm)) return null;
  return norm;
}

// ---------------------------------------------------------------------------
// Zero-dependency ZIP reader. Like sync-lib.listZipEntries it walks the End-Of-
// Central-Directory + central directory, but it also follows each record to its
// local header and inflates the payload (stored=0 or deflate=8). Sizes/method/
// offset come from the *central* directory (authoritative even when a local
// header uses a streaming data-descriptor). ZIP64 is not handled — CodeGrid zips
// are far below the 4GB / 65535-entry limits.
// ---------------------------------------------------------------------------
const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

export function extractZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0x10000; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found (not a zip or truncated)');

  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const records = [];
  for (let i = 0; i < total; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== SIG_CEN) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nLen = buf.readUInt16LE(off + 28);
    const eLen = buf.readUInt16LE(off + 30);
    const cLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nLen);
    records.push({ name, method, compSize, localOff });
    off += 46 + nLen + eLen + cLen;
  }

  const entries = [];
  for (const r of records) {
    if (r.name.endsWith('/')) continue; // directory marker
    if (r.localOff + 30 > buf.length || buf.readUInt32LE(r.localOff) !== SIG_LOC) {
      entries.push({ name: r.name, data: null, size: 0, error: 'bad local header' });
      continue;
    }
    const lnLen = buf.readUInt16LE(r.localOff + 26);
    const leLen = buf.readUInt16LE(r.localOff + 28);
    const start = r.localOff + 30 + lnLen + leLen;
    const comp = buf.subarray(start, start + r.compSize);
    try {
      const data = r.method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp);
      entries.push({ name: r.name, data, size: data.length });
    } catch (e) {
      entries.push({ name: r.name, data: null, size: 0, error: e.message });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Manifest math — pure summaries used by ingest.mjs to build corpus/manifest.json.
// ---------------------------------------------------------------------------
export function humanBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Split extracted entries into kept text files vs. skipped (junk / binary),
 *  attaching language + byte tallies. `files` are shaped { name, size }. */
export function partitionEntries(files) {
  const kept = [];
  const skipped = [];
  for (const f of files) {
    if (isJunkPath(f.name)) { skipped.push({ ...f, reason: 'junk' }); continue; }
    if (!isTextFile(f.name)) { skipped.push({ ...f, reason: 'binary' }); continue; }
    kept.push({ name: f.name, size: f.size, lang: langOf(f.name) });
  }
  return { kept, skipped };
}

/** Per-project rollup from the kept text files. */
export function summarizeProject(kept) {
  const byLang = {};
  let textBytes = 0;
  for (const f of kept) {
    byLang[f.lang] = (byLang[f.lang] || 0) + 1;
    textBytes += f.size || 0;
  }
  return { fileCount: kept.length, textBytes, byLang };
}

/** Corpus-wide rollup across per-project manifest records. */
export function aggregate(projects) {
  const totals = { projects: 0, files: 0, textBytes: 0, byType: {}, byLang: {} };
  for (const p of projects) {
    if (p.status && p.status !== 'ok') continue;
    totals.projects += 1;
    totals.files += p.fileCount || 0;
    totals.textBytes += p.textBytes || 0;
    if (p.type) totals.byType[p.type] = (totals.byType[p.type] || 0) + 1;
    for (const [lang, n] of Object.entries(p.byLang || {})) {
      totals.byLang[lang] = (totals.byLang[lang] || 0) + n;
    }
  }
  return totals;
}

/** The full download plan derived from data/index.json — computable offline, so
 *  it doubles as a dry-run of the whole harness (see `ingest.mjs plan`). */
export function planDownloads(index, base) {
  return (index.projects || []).map((p) => ({
    id: p.id,
    folder: p.folder,
    type: p.type,
    zip: p.zip,
    url: p.zip ? zipUrl(base, p.folder, p.zip) : null,
    expectedZipBytes: p.media?.zips?.[0]?.size ?? null,
  }));
}
