import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeFilename, folderNameForMessage, extractAttachments, classify, pickEntryHtml,
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

test('sanitizeFilename replaces backslash with underscore', () => {
  assert.equal(sanitizeFilename('a\\b'), 'a_b');
});

test('extractAttachments returns empty buckets for message with no attachments', () => {
  assert.deepEqual(extractAttachments({}), { zips: [], images: [], videos: [] });
});

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
