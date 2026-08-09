import test from 'node:test';
import assert from 'node:assert/strict';

test('fetchAndExtractZip requests the same-origin asset proxy', async () => {
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(new Uint8Array([1, 2, 3]));
  };
  globalThis.JSZip = {
    async loadAsync() {
      return { forEach() {} };
    },
  };

  const { fetchAndExtractZip } = await import('./zip.ts');
  await fetchAndExtractZip('demo folder', 'CODE.zip');

  assert.equal(requestedUrl, '/api/assets/demo%20folder/CODE.zip');
});
