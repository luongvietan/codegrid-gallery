# Daily CI Auto-Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily GitHub Actions job that fetches only *new* CodeGrid Discord posts, uploads their assets to R2, updates `data/index.json`, and pushes — so the live Vercel gallery stays current with no manual steps.

**Architecture:** One pure, unit-tested helper module (`scripts/sync-lib.mjs`) holds all message-parsing, zip-classification, and index-merge logic. One I/O orchestrator (`scripts/ci-sync.mjs`) reads `data/index.json` as the "already-published" ledger, calls Discord with `?after=<newest msgId>`, processes only unseen zip-bearing posts (download → upload to R2 → verify → build index entry), writes the merged index, and signals `changed`. A workflow (`.github/workflows/daily-sync.yml`) runs it on cron + manual dispatch and commits the result.

**Tech Stack:** Node 20 (global `fetch`, `node:test`), AWS CLI (preinstalled on `ubuntu-latest`) for R2 via S3 API, GitHub Actions, Vercel (deploys on push). No new npm dependencies.

**Working directory:** `D:/codegrid-gallery-app` (the `luongvietan/codegrid-gallery` repo).

**Spec:** `docs/superpowers/specs/2026-06-19-daily-ci-sync-design.md`

**Conventions for every task below:**
- Run tests with: `node --test scripts/sync-lib.test.mjs`
- Commit **locally only — do NOT push.** Pushing triggers a Vercel deploy and must wait until the workflow + secrets are ready (see "Deployment & enablement").
- Stage only the files each task names; the working tree has an unrelated `.gitignore` modification — leave it alone.

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/sync-lib.mjs` | Pure helpers: message → folder/attachments, zip listing/classify/entryHtml, index merge. No I/O. |
| `scripts/sync-lib.test.mjs` | `node:test` unit tests for every pure helper. |
| `scripts/ci-sync.mjs` | Orchestrator: env, Discord fetch, download, R2 upload+verify, write index, `changed` output. |
| `.github/workflows/daily-sync.yml` | Cron + manual trigger; runs orchestrator; commits + pushes if changed. |

---

## Task 1: Message-parsing helpers

**Files:**
- Create: `scripts/sync-lib.mjs`
- Test: `scripts/sync-lib.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `scripts/sync-lib.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeFilename, folderNameForMessage, extractAttachments,
} from './sync-lib.mjs';

test('sanitizeFilename replaces invalid chars and trims', () => {
  assert.equal(sanitizeFilename('  a/b:c?*d  '), 'a_b_c__d');
});

test('folderNameForMessage extracts bold title, prefixes date', () => {
  const msg = { id: '123', timestamp: '2026-06-17T20:00:00+00:00', content: '<:js:1> **HELLO WORLD**' };
  assert.equal(folderNameForMessage(msg), '2026-06-17_HELLO WORLD');
});

test('folderNameForMessage falls back to msgId when no bold title', () => {
  const msg = { id: '999', timestamp: '2026-06-17T00:00:00+00:00', content: 'no title here' };
  assert.equal(folderNameForMessage(msg), '2026-06-17_999');
});

test('folderNameForMessage caps title to 60 chars (slice before sanitize)', () => {
  const long = 'X'.repeat(80);
  const msg = { id: '1', timestamp: '2026-01-01T00:00:00Z', content: `**${long}**` };
  assert.equal(folderNameForMessage(msg), `2026-01-01_${'X'.repeat(60)}`);
});

test('extractAttachments buckets by extension and content_type', () => {
  const msg = { attachments: [
    { url: 'u1', filename: 'CODE.zip', size: 10 },
    { url: 'u2', filename: 'thumb.JPG', size: 20 },
    { url: 'u3', filename: 'clip.mp4', size: 30 },
    { url: 'u4', filename: 'noext', size: 40, content_type: 'image/png' },
  ] };
  const a = extractAttachments(msg);
  assert.deepEqual(a.zips.map((x) => x.filename), ['CODE.zip']);
  assert.deepEqual(a.images.map((x) => x.filename), ['thumb.JPG', 'noext']);
  assert.deepEqual(a.videos.map((x) => x.filename), ['clip.mp4']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/sync-lib.test.mjs`
Expected: FAIL — `Cannot find module './sync-lib.mjs'` (file not created yet).

- [ ] **Step 3: Create `scripts/sync-lib.mjs` with the three helpers**

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/sync-lib.test.mjs`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-lib.mjs scripts/sync-lib.test.mjs
git commit -m "feat(ci): message-parsing helpers for daily sync"
```

---

## Task 2: Zip listing + classification helpers

**Files:**
- Modify: `scripts/sync-lib.mjs` (append)
- Modify: `scripts/sync-lib.test.mjs` (append)

- [ ] **Step 1: Append failing tests**

Append to `scripts/sync-lib.test.mjs` (add the new names to the existing import from `./sync-lib.mjs`: `classify, pickEntryHtml`):

```js
import { classify, pickEntryHtml } from './sync-lib.mjs';

test('classify: next.config => nextjs, package.json => react, else html', () => {
  assert.equal(classify(['app/next.config.mjs', 'app/package.json']), 'nextjs');
  assert.equal(classify(['proj/package.json', 'proj/src/x.js']), 'react');
  assert.equal(classify(['index.html', 'style.css']), 'html');
  assert.equal(classify(['__MACOSX/package.json', 'index.html']), 'html');
});

test('pickEntryHtml prefers shallowest index.html, ignores __MACOSX', () => {
  assert.equal(pickEntryHtml(['a/b/index.html', 'index.html']), 'index.html');
  assert.equal(pickEntryHtml(['__MACOSX/index.html', 'sub/page.html']), 'sub/page.html');
  assert.equal(pickEntryHtml(['main.css']), null);
});
```

> Note: import lines may be merged with Task 1's import, or added as a second `import` from the same module — both are valid ESM.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/sync-lib.test.mjs`
Expected: FAIL — `classify`/`pickEntryHtml` are not exported.

- [ ] **Step 3: Append the helpers to `scripts/sync-lib.mjs`**

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/sync-lib.test.mjs`
Expected: PASS — all tests (7 total) pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-lib.mjs scripts/sync-lib.test.mjs
git commit -m "feat(ci): zip listing + classification helpers"
```

---

## Task 3: Index helpers (entry build + merge + ledger)

**Files:**
- Modify: `scripts/sync-lib.mjs` (append)
- Modify: `scripts/sync-lib.test.mjs` (append)

- [ ] **Step 1: Append failing tests**

Append to `scripts/sync-lib.test.mjs` (import `slug, prettyTitle, pickThumbnail, buildProjectEntry, knownMsgIds, newestMsgId, mergeIndex`):

```js
import {
  slug, prettyTitle, pickThumbnail, buildProjectEntry, knownMsgIds, newestMsgId, mergeIndex,
} from './sync-lib.mjs';

test('slug and prettyTitle', () => {
  assert.equal(slug('2026-06-17_HELLO WORLD!!'), '2026_06_17_HELLO_WORLD');
  assert.equal(prettyTitle('2026-06-17_HELLO_WORLD'), 'HELLO WORLD');
});

test('pickThumbnail prefers png then jpg/webp', () => {
  assert.equal(pickThumbnail([{ filename: 'a.jpg' }, { filename: 'b.png' }]), 'b.png');
  assert.equal(pickThumbnail([{ filename: 'a.jpg' }]), 'a.jpg');
  assert.equal(pickThumbnail([]), null);
});

test('buildProjectEntry shape', () => {
  const msg = { id: '7', timestamp: '2026-06-17T20:00:00Z', author: { username: 'harrnish' } };
  const att = { zips: [{ url: 'z', filename: 'CODE.zip', size: 1 }], images: [{ url: 'i', filename: 'c.jpg', size: 2 }], videos: [] };
  const e = buildProjectEntry({ msg, folder: '2026-06-17_FOO', type: 'react', entryHtml: null, attachments: att });
  assert.equal(e.id, '2026_06_17_FOO');
  assert.equal(e.title, 'FOO');
  assert.equal(e.type, 'react');
  assert.equal(e.msgId, '7');
  assert.equal(e.thumbnail, 'c.jpg');
  assert.equal(e.zip, 'CODE.zip');
  assert.equal(e.author, 'harrnish');
  assert.deepEqual(e.media.zips, att.zips);
});

test('knownMsgIds and newestMsgId', () => {
  const index = { projects: [{ msgId: '100' }, { msgId: '300' }, { msgId: '200' }] };
  assert.ok(knownMsgIds(index).has('300'));
  assert.equal(newestMsgId(index), '300');
});

test('mergeIndex dedupes by id, sorts by folder, recomputes counts', () => {
  const index = { projects: [{ id: 'b', folder: '2026-02_B', type: 'html', msgId: '2' }] };
  const merged = mergeIndex(index, [{ id: 'a', folder: '2026-01_A', type: 'react', msgId: '1' }]);
  assert.deepEqual(merged.projects.map((p) => p.id), ['a', 'b']);
  assert.deepEqual(merged.counts, { react: 1, html: 1 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/sync-lib.test.mjs`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Append the helpers to `scripts/sync-lib.mjs`**

```js
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
  return (png || other || images[0])?.filename ?? null;
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
    if (!p.msgId) continue;
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/sync-lib.test.mjs`
Expected: PASS — all tests (12 total) pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-lib.mjs scripts/sync-lib.test.mjs
git commit -m "feat(ci): index entry build, merge, and ledger helpers"
```

---

## Task 4: Orchestrator `scripts/ci-sync.mjs`

This is I/O glue (Discord fetch, downloads, R2 upload/verify, write). It is validated by a syntax check here and a real `workflow_dispatch` run later — no unit test (the pure logic it calls is already covered).

**Files:**
- Create: `scripts/ci-sync.mjs`

- [ ] **Step 1: Create `scripts/ci-sync.mjs`**

```js
#!/usr/bin/env node
// scripts/ci-sync.mjs — daily incremental sync orchestrator. See docs/superpowers/specs/2026-06-19-daily-ci-sync-design.md
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  folderNameForMessage, extractAttachments, listZipEntries, classify,
  pickEntryHtml, buildProjectEntry, knownMsgIds, newestMsgId, mergeIndex,
} from './sync-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = path.join(ROOT, 'data', 'index.json');

const {
  DISCORD_TOKEN, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
  CHANNEL_ID, R2_ENDPOINT, R2_BUCKET,
} = process.env;

function requireEnv() {
  const missing = ['DISCORD_TOKEN', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'CHANNEL_ID', 'R2_ENDPOINT', 'R2_BUCKET']
    .filter((k) => !process.env[k]);
  if (missing.length) { console.error(`[ERROR] Missing env: ${missing.join(', ')}`); process.exit(1); }
}

const awsEnv = () => ({
  ...process.env,
  AWS_ACCESS_KEY_ID: R2_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: R2_SECRET_ACCESS_KEY,
  AWS_DEFAULT_REGION: 'auto',
});

async function fetchMessagesAfter(channelId, afterId, token) {
  let url = `https://discord.com/api/v9/channels/${channelId}/messages?limit=100`;
  if (afterId) url += `&after=${afterId}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(url, { headers: { Authorization: token, 'User-Agent': 'codegrid-ci/1.0' } });
    if (resp.status === 429) {
      const body = await resp.json().catch(() => ({}));
      const wait = (body.retry_after || 5) * 1000;
      console.log(`Rate limited; waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Discord auth failed (HTTP ${resp.status}). Refresh the DISCORD_TOKEN secret.`);
    }
    if (!resp.ok) throw new Error(`Discord HTTP ${resp.status}: ${await resp.text()}`);
    const batch = await resp.json();
    if (batch.length === 100) console.warn('[WARN] 100 messages returned — back-catalog gap larger than one page.');
    return batch;
  }
  throw new Error('Discord fetch failed after retries');
}

async function downloadTo(url, dest) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'codegrid-ci/1.0' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length === 0) throw new Error('empty download');
      fs.writeFileSync(dest, buf);
      return;
    } catch (e) {
      if (attempt === 3) throw new Error(`Download failed for ${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

function uploadFolderToR2(localDir, folder) {
  execFileSync('aws', ['s3', 'cp', localDir, `s3://${R2_BUCKET}/${folder}`, '--recursive', '--endpoint-url', R2_ENDPOINT],
    { env: awsEnv(), stdio: 'inherit' });
}

function verifyR2(folder, filenames) {
  const out = execFileSync('aws', ['s3', 'ls', `s3://${R2_BUCKET}/${folder}/`, '--endpoint-url', R2_ENDPOINT],
    { env: awsEnv() }).toString();
  for (const f of filenames) {
    if (!out.includes(f)) throw new Error(`R2 verify failed: ${folder}/${f} missing after upload`);
  }
}

function setChanged() {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'changed=true\n');
}

async function main() {
  requireEnv();
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const known = knownMsgIds(index);
  const after = newestMsgId(index);
  console.log(`Ledger: ${index.projects.length} projects, newest msgId=${after}`);

  const msgs = await fetchMessagesAfter(CHANNEL_ID, after, DISCORD_TOKEN);
  const candidates = msgs
    .filter((m) => !known.has(m.id) && extractAttachments(m).zips.length > 0)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  console.log(`New posts with a zip: ${candidates.length}`);
  if (candidates.length === 0) { console.log('Nothing to do.'); return; }

  const newEntries = [];
  for (const msg of candidates) {
    const folder = folderNameForMessage(msg);
    const att = extractAttachments(msg);
    const all = [...att.zips, ...att.images, ...att.videos];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
    const dir = path.join(tmp, folder);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`\n-> ${folder} (${all.length} files)`);
    try {
      for (const f of all) await downloadTo(f.url, path.join(dir, f.filename));
      uploadFolderToR2(dir, folder);
      verifyR2(folder, all.map((f) => f.filename));
      const names = listZipEntries(fs.readFileSync(path.join(dir, att.zips[0].filename)));
      newEntries.push(buildProjectEntry({ msg, folder, type: classify(names), entryHtml: pickEntryHtml(names), attachments: att }));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const merged = mergeIndex(index, newEntries);
  fs.writeFileSync(INDEX_PATH, JSON.stringify(merged));
  setChanged();
  console.log(`\nDone. Added ${newEntries.length} project(s); index now ${merged.projects.length}.`);
}

main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
```

- [ ] **Step 2: Verify it parses and imports cleanly (no run — needs secrets/network)**

Run: `node --check scripts/ci-sync.mjs && node -e "import('./scripts/ci-sync.mjs').catch(e=>{console.log('import side-effect:',e.message)})"`
Expected: `node --check` prints nothing (syntax OK). The import line runs `main()`, which calls `requireEnv()` and exits with `[ERROR] Missing env: ...` because no secrets are set — that error text confirms the wiring is correct.

> Simpler alternative if the above is awkward: just `node --check scripts/ci-sync.mjs` (syntax only), then `node scripts/ci-sync.mjs` and confirm it prints `[ERROR] Missing env: DISCORD_TOKEN, ...` and exits non-zero.

- [ ] **Step 3: Commit**

```bash
git add scripts/ci-sync.mjs
git commit -m "feat(ci): incremental Discord->R2->index sync orchestrator"
```

---

## Task 5: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/daily-sync.yml`

- [ ] **Step 1: Create `.github/workflows/daily-sync.yml`**

```yaml
name: daily-sync
on:
  schedule:
    - cron: "0 6 * * *"        # 06:00 UTC = 13:00 Vietnam, daily
  workflow_dispatch: {}         # manual "Run workflow" button
permissions:
  contents: write               # commit + push via GITHUB_TOKEN
concurrency:
  group: daily-sync
  cancel-in-progress: false
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Run unit tests
        run: node --test scripts/sync-lib.test.mjs
      - name: Sync new posts
        id: sync
        env:
          DISCORD_TOKEN: ${{ secrets.DISCORD_TOKEN }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          CHANNEL_ID: "1048241543477215275"
          R2_ENDPOINT: "https://c43c4f2af4941428dc86d37bffcb7800.r2.cloudflarestorage.com"
          R2_BUCKET: "codegrid-gallery"
        run: node scripts/ci-sync.mjs
      - name: Commit & push if changed
        if: steps.sync.outputs.changed == 'true'
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/index.json
          git commit -m "data: auto-sync new CodeGrid post(s)"
          git push
```

> Do NOT add `[skip ci]` to the commit message — Vercel honors it and would skip the deploy. A plain `GITHUB_TOKEN` push does not re-trigger Actions but does fire Vercel's deploy webhook.

- [ ] **Step 2: Validate YAML parses**

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/daily-sync.yml','utf8');if(!/on:|schedule:|workflow_dispatch|ci-sync\.mjs/.test(s))throw new Error('workflow content check failed');console.log('workflow file present and contains expected keys')"`
Expected: prints the confirmation line (basic content sanity; full validation happens when GitHub parses it on push).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/daily-sync.yml
git commit -m "ci: daily-sync workflow (cron + manual dispatch)"
```

---

## Deployment & enablement (manual — not a subagent task)

These steps publish and turn on the automation. They require the human (secrets, GitHub UI) and an outward push, so they are done deliberately after the code tasks and after the user confirms.

1. **Add GitHub Secrets** (repo → Settings → Secrets and variables → Actions → New repository secret):
   - `DISCORD_TOKEN` — current Discord user token (rotate first if not already done).
   - `R2_ACCESS_KEY_ID` — from `~/.aws/credentials` `[r2]`.
   - `R2_SECRET_ACCESS_KEY` — from `~/.aws/credentials` `[r2]`.
2. **Push** the local commits: `git push origin master`. (This redeploys Vercel with unchanged `data/index.json` — harmless — and registers the workflow.)
3. **Test manually:** GitHub → Actions → "daily-sync" → "Run workflow". Confirm it succeeds and, if there's a new post, that it commits `data/index.json` and Vercel deploys.
4. **Confirm schedule:** the cron entry runs daily at 06:00 UTC thereafter. A failed run emails the repo owner (signal to refresh `DISCORD_TOKEN`).

---

## Self-review notes (author)

- **Spec coverage:** ledger via `data/index.json` (Task 3 `knownMsgIds`/`newestMsgId`); `?after=` fetch + zip-only + dedupe selection (Task 4 `main`); folder-name parity (Task 1); per-folder R2 upload + verify-before-index ordering (Task 4); merge/sort/counts (Task 3); workflow triggers/permissions/concurrency/secrets (Task 5); failure email via non-zero exit (Task 4 `throw`/`process.exit`); tests (Tasks 1-3, plus run in workflow). All spec sections map to a task.
- **No placeholders:** every code/test/command block is concrete.
- **Type consistency:** function names and the `{ msg, folder, type, entryHtml, attachments }` argument object used in Task 4 match the exports defined in Tasks 1-3; `mergeIndex`/`buildProjectEntry`/`extractAttachments` shapes are consistent across tasks.
