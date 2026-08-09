#!/usr/bin/env node
// scripts/ci-sync.mjs — daily incremental sync orchestrator. See docs/superpowers/specs/2026-06-19-daily-ci-sync-design.md
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  artifactUploadArgs, retryDelayMs, folderNameForMessage, extractAttachments,
  pickEntryHtml, buildProjectEntry, knownMsgIds, newestMsgId, mergeIndex,
} from './sync-lib.mjs';
import { inspectTemplateArchive, validateArchiveRecords } from './preview-classifier.mjs';
import { BUILDER_VERSION, buildStaticPreview, sourceHash } from './preview-builder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = path.join(ROOT, 'data', 'index.json');

const {
  DISCORD_TOKEN, CHANNEL_ID, R2_ENDPOINT, R2_BUCKET,
} = process.env;
const MAX_ATTEMPTS = 5;
const BUILDABLE_RUNTIMES = new Set(['vite-vanilla', 'vite-react', 'cra']);

function requireEnv() {
  const missing = ['DISCORD_TOKEN', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'CHANNEL_ID', 'R2_ENDPOINT', 'R2_BUCKET']
    .filter((k) => !process.env[k]);
  if (missing.length) { console.error(`[ERROR] Missing env: ${missing.join(', ')}`); process.exit(1); }
}

const awsEnv = () => ({
  ...process.env,
  AWS_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  AWS_DEFAULT_REGION: 'auto',
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function retryAfterHeaderMs(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function retryAfterErrorMs(error) {
  const detail = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join('\n');
  const match = detail.match(/(?:retry-after\s*[:=]|<RetryAfterSeconds>)\s*(\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) * 1_000 : null;
}

function isTransientAwsError(error) {
  const detail = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join('\n');
  return /\b(?:429|5\d\d)\b|SlowDown|Throttl|RequestTimeout|ServiceUnavailable|InternalError/i.test(detail);
}

async function runAws(args, options = {}) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return execFileSync('aws', args, { env: awsEnv(), ...options });
    } catch (error) {
      if (attempt === MAX_ATTEMPTS - 1 || !isTransientAwsError(error)) {
        if (error?.stderr) process.stderr.write(error.stderr);
        throw error;
      }
      const wait = retryDelayMs(attempt, retryAfterErrorMs(error));
      console.log(`R2 request throttled or unavailable; waiting ${wait}ms`);
      await delay(wait);
    }
  }
  throw new Error('R2 request failed after retries');
}

async function fetchMessagesAfter(channelId, afterId, token) {
  let url = `https://discord.com/api/v9/channels/${channelId}/messages?limit=100`;
  if (afterId) url += `&after=${afterId}`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const resp = await fetch(url, { headers: { Authorization: token, 'User-Agent': 'codegrid-ci/1.0' } });
    if (resp.status === 429) {
      const body = await resp.json().catch(() => ({}));
      if (attempt === MAX_ATTEMPTS - 1) break;
      const retryAfter = retryAfterHeaderMs(resp.headers.get('retry-after'))
        ?? (Number.isFinite(Number(body.retry_after)) ? Number(body.retry_after) * 1_000 : null);
      const wait = retryDelayMs(attempt, retryAfter);
      console.log(`Rate limited; waiting ${wait}ms`);
      await delay(wait);
      continue;
    }
    if (resp.status >= 500) {
      if (attempt === MAX_ATTEMPTS - 1) break;
      await delay(retryDelayMs(attempt, retryAfterHeaderMs(resp.headers.get('retry-after'))));
      continue;
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Discord auth failed (HTTP ${resp.status}). Refresh the DISCORD_TOKEN secret.`);
    }
    if (!resp.ok) throw new Error(`Discord HTTP ${resp.status}: ${await resp.text()}`);
    const batch = await resp.json();
    if (batch.length === 100) {
      throw new Error('Discord returned a full page (100 new messages) after the last known id. This is more than one page of new posts; run the manual backfill (download_codegrid.py + build-index) instead — the daily sync is incremental-only.');
    }
    return batch;
  }
  throw new Error('Discord fetch failed after retries');
}

async function downloadTo(url, dest) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'codegrid-ci/1.0' } });
      if (resp.status === 429 || resp.status >= 500) {
        if (attempt === MAX_ATTEMPTS - 1) throw new Error(`HTTP ${resp.status}`);
        const wait = retryDelayMs(attempt, retryAfterHeaderMs(resp.headers.get('retry-after')));
        console.log(`Attachment request throttled or unavailable; waiting ${wait}ms`);
        await delay(wait);
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length === 0) throw new Error('empty download');
      fs.writeFileSync(dest, buf);
      return;
    } catch (e) {
      if (attempt === MAX_ATTEMPTS - 1 || /^HTTP 4\d\d$/.test(e.message)) {
        throw new Error(`Download failed for ${url}: ${e.message}`);
      }
      await delay(retryDelayMs(attempt, null));
    }
  }
}

async function uploadFolderToR2(localDir, folder) {
  await runAws(['s3', 'cp', localDir, `s3://${R2_BUCKET}/${folder}`, '--recursive', '--endpoint-url', R2_ENDPOINT],
    { stdio: ['ignore', 'inherit', 'pipe'] });
}

async function verifyR2(folder, filenames) {
  const out = (await runAws(['s3', 'ls', `s3://${R2_BUCKET}/${folder}/`, '--endpoint-url', R2_ENDPOINT])).toString();
  const lines = out.split('\n');
  for (const f of filenames) {
    if (!lines.some((l) => l.endsWith(' ' + f))) {
      throw new Error(`R2 verify failed: ${folder}/${f} missing after upload`);
    }
  }
}

function extractValidatedArchive(zipPath, projectDir, records) {
  validateArchiveRecords(records);
  fs.mkdirSync(projectDir, { recursive: true });
  execFileSync('unzip', ['-q', zipPath, '-d', projectDir], { stdio: 'inherit' });
}

function unavailableBuild(zipBuffer, runtime, failureCode) {
  return {
    status: 'build-failed',
    outputDir: null,
    preview: {
      mode: 'unavailable',
      runtime,
      sourceHash: sourceHash(zipBuffer, runtime),
      artifactBase: null,
      entry: null,
      status: 'build-failed',
      builderVersion: BUILDER_VERSION,
      failureCode,
    },
  };
}

function disabledBuild(inspection, zipBuffer) {
  return {
    status: 'runtime-required',
    outputDir: null,
    preview: {
      mode: 'webcontainer',
      runtime: inspection.runtime,
      sourceHash: sourceHash(zipBuffer, inspection.runtime),
      artifactBase: null,
      entry: null,
      status: 'runtime-required',
      builderVersion: BUILDER_VERSION,
      failureCode: null,
    },
  };
}

function archiveFailureCode(error) {
  return /too many entries|expanded size exceeds/i.test(error?.message || '')
    ? 'archive-too-large'
    : 'archive-invalid';
}

async function uploadReadyArtifact(build) {
  await runAws(artifactUploadArgs(build.outputDir, build.preview.sourceHash, R2_BUCKET, R2_ENDPOINT),
    { stdio: ['ignore', 'inherit', 'pipe'] });
  await runAws([
    's3api', 'head-object', '--bucket', R2_BUCKET,
    '--key', `previews/${build.preview.sourceHash}/index.html`,
    '--endpoint-url', R2_ENDPOINT,
  ], { stdio: ['ignore', 'inherit', 'pipe'] });
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
    .flatMap((m) => {
      const att = extractAttachments(m);
      return !known.has(m.id) && att.zips.length > 0 ? [{ msg: m, att }] : [];
    })
    .sort((a, b) => (BigInt(a.msg.id) < BigInt(b.msg.id) ? -1 : 1));
  console.log(`New posts with a zip: ${candidates.length}`);
  if (candidates.length === 0) { console.log('Nothing to do.'); return; }

  const newEntries = [];
  for (const { msg, att } of candidates) {
    const folder = folderNameForMessage(msg);
    const all = [...att.zips, ...att.images, ...att.videos];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
    const dir = path.join(tmp, folder);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`\n-> ${folder} (${all.length} files)`);
    try {
      for (const f of all) {
        const dest = path.resolve(dir, f.filename);
        if (!dest.startsWith(path.resolve(dir) + path.sep)) {
          throw new Error(`Unsafe or empty attachment filename in message ${msg.id}: ${JSON.stringify(f.filename)}`);
        }
        await downloadTo(f.url, dest);
      }
      await uploadFolderToR2(dir, folder);
      await verifyR2(folder, all.map((f) => f.filename));

      const zipPath = path.join(dir, att.zips[0].filename);
      const zipBuffer = fs.readFileSync(zipPath);
      let inspection = null;
      let build;
      let stage = 'archive';
      try {
        inspection = inspectTemplateArchive(zipBuffer);
        validateArchiveRecords(inspection.records);
        const projectDir = path.join(tmp, 'source');
        extractValidatedArchive(zipPath, projectDir, inspection.records);
        stage = 'build';
        build = process.env.PREVIEW_BUILD_ENABLED === 'false' && BUILDABLE_RUNTIMES.has(inspection.runtime)
          ? disabledBuild(inspection, zipBuffer)
          : await buildStaticPreview({
            inspection,
            zipBuffer,
            projectDir: path.join(projectDir, inspection.root),
            cacheDir: path.join(os.tmpdir(), 'codegrid-npm-cache'),
          });

        if (build.preview.status === 'ready') {
          stage = 'artifact';
          await uploadReadyArtifact(build);
        }
      } catch (error) {
        const failureCode = stage === 'archive' ? archiveFailureCode(error) : 'build-failed';
        const runtime = inspection?.runtime ?? 'unsupported';
        build = unavailableBuild(zipBuffer, runtime, failureCode);
        console.error(`[PREVIEW] ${folder}: ${failureCode}: ${error.message}`);
      }

      newEntries.push(buildProjectEntry({
        msg,
        folder,
        runtime: inspection?.runtime ?? 'unsupported',
        preview: build.preview,
        entryHtml: pickEntryHtml(inspection?.names ?? []),
        attachments: att,
      }));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const merged = mergeIndex(index, newEntries);
  const tmpIndex = INDEX_PATH + '.tmp';
  fs.writeFileSync(tmpIndex, JSON.stringify(merged));
  fs.renameSync(tmpIndex, INDEX_PATH);
  setChanged();
  console.log(`\nDone. Added ${newEntries.length} project(s); index now ${merged.projects.length}.`);
}

main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
