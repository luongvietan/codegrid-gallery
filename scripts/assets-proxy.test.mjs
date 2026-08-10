import test from 'node:test';
import assert from 'node:assert/strict';

const appBase = process.env.TEST_APP_BASE || 'http://127.0.0.1:3010';
const folder = '2026-08-05_I BUILT A SPINNING 3D CAROUSEL WITH ZERO LIBRARIES AND GSAP';
const path = folder.split('/').map(encodeURIComponent).join('/');

test('serves an R2 zip through the same-origin asset proxy', async () => {
  const response = await fetch(`${appBase}/api/assets/${path}/CODE.zip`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /zip|octet-stream/i);
  assert.ok((await response.arrayBuffer()).byteLength > 1000);
});
