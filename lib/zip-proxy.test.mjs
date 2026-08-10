import test from 'node:test';
import assert from 'node:assert/strict';

const SAFETY_ERROR = 'ZIP vượt quá giới hạn an toàn.';

function fakeArchive(entries) {
  return {
    forEach(callback) {
      for (const [name, entry] of entries) callback(name, entry);
    },
  };
}

function fakeEntry({ size = 0, extract, dir = false } = {}) {
  return {
    dir,
    _data: { uncompressedSize: size },
    async: extract ?? (async () => new ArrayBuffer(size)),
  };
}

async function configureZip({ response, entries = [] }) {
  globalThis.fetch = async () => response ?? new Response(new Uint8Array([1, 2, 3]));
  globalThis.JSZip = {
    async loadAsync() {
      return fakeArchive(entries);
    },
  };
  return import('./zip.ts');
}

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

test('rejects an oversized compressed payload from Content-Length before reading its body', async () => {
  let bodyRead = false;
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(32 * 1024 * 1024 + 1) }),
    async arrayBuffer() {
      bodyRead = true;
      return new ArrayBuffer(1);
    },
  };
  const { fetchAndExtractZip } = await configureZip({ response });

  await assert.rejects(() => fetchAndExtractZip('demo', 'CODE.zip'), { message: SAFETY_ERROR });
  assert.equal(bodyRead, false);
});

test('stops reading an oversized compressed payload when Content-Length is absent', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let pulls = 0;
  let cancelled = false;
  let arrayBufferCalled = false;
  const response = {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader() {
        return {
          async read() {
            pulls += 1;
            return { done: false, value: chunk };
          },
          async cancel() { cancelled = true; },
          releaseLock() {},
        };
      },
    },
    async arrayBuffer() {
      arrayBufferCalled = true;
      return new ArrayBuffer(32 * 1024 * 1024 + 1);
    },
  };
  const { fetchAndExtractZip } = await configureZip({ response });

  await assert.rejects(() => fetchAndExtractZip('demo', 'CODE.zip'), { message: SAFETY_ERROR });
  assert.equal(arrayBufferCalled, false);
  assert.equal(pulls, 33);
  assert.equal(cancelled, true);
});

test('rejects archives with too many entries before extracting files', async () => {
  let extracted = 0;
  const entries = Array.from({ length: 4_001 }, (_, index) => [
    `src/file-${index}.ts`,
    fakeEntry({ extract: async () => { extracted += 1; return new ArrayBuffer(1); } }),
  ]);
  const { fetchAndExtractZip } = await configureZip({ entries });

  await assert.rejects(() => fetchAndExtractZip('demo', 'CODE.zip'), { message: SAFETY_ERROR });
  assert.equal(extracted, 0);
});

test('rejects a declared oversized file before extraction', async () => {
  let extracted = 0;
  const oversizedFile = [[
    'public/video.bin',
    fakeEntry({
      size: 16 * 1024 * 1024 + 1,
      extract: async () => { extracted += 1; return new ArrayBuffer(1); },
    }),
  ]];
  const { fetchAndExtractZip } = await configureZip({ entries: oversizedFile });

  await assert.rejects(() => fetchAndExtractZip('demo', 'CODE.zip'), { message: SAFETY_ERROR });
  assert.equal(extracted, 0);
});

test('rejects a declared oversized expanded total before extraction', async () => {
  let extracted = 0;
  const oversizedTotal = Array.from({ length: 129 }, (_, index) => [
    `src/chunk-${index}.js`,
    fakeEntry({
      size: 1024 * 1024,
      extract: async () => { extracted += 1; return new ArrayBuffer(1); },
    }),
  ]);
  const { fetchAndExtractZip } = await configureZip({ entries: oversizedTotal });

  await assert.rejects(() => fetchAndExtractZip('demo', 'CODE.zip'), { message: SAFETY_ERROR });
  assert.equal(extracted, 0);
});

test('extracts accepted files sequentially', async () => {
  let active = 0;
  let maxActive = 0;
  const sequentialEntries = ['src/a.ts', 'src/b.ts'].map((name) => [
    name,
    fakeEntry({
      size: 1,
      extract: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return new Uint8Array([name.endsWith('a.ts') ? 1 : 2]).buffer;
      },
    }),
  ]);
  const { fetchAndExtractZip } = await configureZip({ entries: sequentialEntries });
  const result = await fetchAndExtractZip('demo', 'CODE.zip');

  assert.equal(maxActive, 1);
  assert.deepEqual(result.names, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual([...new Uint8Array(result.files.get('src/b.ts'))], [2]);
});

test('rejects an underreported file whose actual expanded size exceeds its budget', async () => {
  const { fetchAndExtractZip } = await configureZip({
    entries: [[
      'src/underreported.bin',
      fakeEntry({ size: 1, extract: async () => new ArrayBuffer(16 * 1024 * 1024 + 1) }),
    ]],
  });

  await assert.rejects(() => fetchAndExtractZip('demo', 'CODE.zip'), { message: SAFETY_ERROR });
});

test('rejects an underreported total while extracting sequentially', async () => {
  const sharedMegabyte = new ArrayBuffer(1024 * 1024);
  const entries = Array.from({ length: 129 }, (_, index) => [
    `src/underreported-${index}.bin`,
    fakeEntry({ size: 1, extract: async () => sharedMegabyte }),
  ]);
  const { fetchAndExtractZip } = await configureZip({ entries });

  await assert.rejects(() => fetchAndExtractZip('demo', 'CODE.zip'), { message: SAFETY_ERROR });
});
