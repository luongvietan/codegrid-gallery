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

test('sanitizeFilename replaces backslash with underscore', () => {
  assert.equal(sanitizeFilename('a\\b'), 'a_b');
});

test('extractAttachments returns empty buckets for message with no attachments', () => {
  assert.deepEqual(extractAttachments({}), { zips: [], images: [], videos: [] });
});
