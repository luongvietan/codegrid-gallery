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
