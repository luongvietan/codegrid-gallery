import test from 'node:test';
import assert from 'node:assert/strict';

const SAFETY_ERROR = 'ZIP vượt quá giới hạn an toàn.';
const MB = 1024 * 1024;
const { ZIP_LIMITS, expandedBudget } = await import('./zip.ts');

function fakeArchive(entries) {
  return {
    forEach(callback) {
      for (const [name, entry] of entries) callback(name, entry);
    },
  };
}

function fakeEntry({ size = 0, extract, dir = false } = {}) {
  const extractContents = extract ?? (async () => new ArrayBuffer(size));
  return {
    dir,
    _data: { uncompressedSize: size },
    async: extractContents,
    internalStream(type) {
      assert.equal(type, 'uint8array');
      const callbacks = {};
      let paused = false;
      return {
        on(event, callback) {
          callbacks[event] = callback;
          return this;
        },
        pause() {
          paused = true;
          return this;
        },
        resume() {
          Promise.resolve()
            .then(extractContents)
            .then((contents) => {
              if (paused) return;
              callbacks.data(new Uint8Array(contents));
              if (!paused) callbacks.end();
            }, (error) => callbacks.error(error));
          return this;
        },
      };
    },
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
    headers: new Headers({ 'content-length': String(ZIP_LIMITS.maxCompressedBytes + 1) }),
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
  const chunk = new Uint8Array(MB);
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
      return new ArrayBuffer(ZIP_LIMITS.maxCompressedBytes + 1);
    },
  };
  const { fetchAndExtractZip } = await configureZip({ response });

  await assert.rejects(() => fetchAndExtractZip('demo', 'CODE.zip'), { message: SAFETY_ERROR });
  assert.equal(arrayBufferCalled, false);
  assert.equal(pulls, ZIP_LIMITS.maxCompressedBytes / MB + 1);
  assert.equal(cancelled, true);
});

test('accepts a media-heavy archive larger than a conservative fixed cap', async () => {
  const compressedBytes = 48 * MB;
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(compressedBytes) }),
    async arrayBuffer() { return new ArrayBuffer(compressedBytes); },
  };
  const { fetchAndExtractZip } = await configureZip({
    response,
    entries: [['public/hero.mp4', fakeEntry({ size: 40 * MB, extract: async () => new ArrayBuffer(40 * MB) })]],
  });

  const result = await fetchAndExtractZip('demo', 'CODE.zip');

  assert.deepEqual(result.names, ['public/hero.mp4']);
  assert.equal(result.files.get('public/hero.mp4').byteLength, 40 * MB);
});

test('scales the expanded budget from the compressed size to keep small bombs bounded', async () => {
  assert.equal(expandedBudget(1), ZIP_LIMITS.minExpandedBytes);
  assert.equal(expandedBudget(8 * MB), 8 * MB * ZIP_LIMITS.maxExpansionRatio);
  assert.equal(expandedBudget(ZIP_LIMITS.maxCompressedBytes), ZIP_LIMITS.maxExpandedBytes);
});

test('rejects a small archive declaring an expansion beyond its ratio budget', async () => {
  let extracted = 0;
  const compressedBytes = 2 * MB;
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(compressedBytes) }),
    async arrayBuffer() { return new ArrayBuffer(compressedBytes); },
  };
  // 2 MB compressed buys 40 MB of output, but the floor keeps the effective budget at 64 MB.
  const entries = Array.from({ length: ZIP_LIMITS.minExpandedBytes / MB + 1 }, (_, index) => [
    `src/chunk-${index}.js`,
    fakeEntry({ size: MB, extract: async () => { extracted += 1; return new ArrayBuffer(1); } }),
  ]);
  const { fetchAndExtractZip } = await configureZip({ response, entries });

  await assert.rejects(() => fetchAndExtractZip('demo', 'CODE.zip'), { message: SAFETY_ERROR });
  assert.equal(extracted, 0);
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
      size: ZIP_LIMITS.maxFileBytes + 1,
      extract: async () => { extracted += 1; return new ArrayBuffer(1); },
    }),
  ]];
  const { fetchAndExtractZip } = await configureZip({ entries: oversizedFile });

  await assert.rejects(() => fetchAndExtractZip('demo', 'CODE.zip'), { message: SAFETY_ERROR });
  assert.equal(extracted, 0);
});

test('rejects a declared oversized expanded total before extraction', async () => {
  let extracted = 0;
  const oversizedTotal = Array.from({ length: ZIP_LIMITS.minExpandedBytes / MB + 1 }, (_, index) => [
    `src/chunk-${index}.js`,
    fakeEntry({
      size: MB,
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
      fakeEntry({ size: 1, extract: async () => new ArrayBuffer(ZIP_LIMITS.minExpandedBytes + 1) }),
    ]],
  });

  await assert.rejects(() => fetchAndExtractZip('demo', 'CODE.zip'), { message: SAFETY_ERROR });
});

test('stops an underreported file stream as soon as expanded chunks exceed the per-file budget', async () => {
  const chunk = new Uint8Array(MB);
  const callbacks = {};
  const chunkLimit = ZIP_LIMITS.minExpandedBytes / MB * 2;
  let emittedChunks = 0;
  let paused = false;
  const forgedEntry = {
    dir: false,
    _data: { uncompressedSize: 1 },
    async: async () => {
      emittedChunks = chunkLimit;
      return new ArrayBuffer(ZIP_LIMITS.minExpandedBytes + 1);
    },
    internalStream(type) {
      assert.equal(type, 'uint8array');
      return {
        on(event, callback) {
          callbacks[event] = callback;
          return this;
        },
        pause() {
          paused = true;
          return this;
        },
        resume() {
          while (!paused && emittedChunks < chunkLimit) {
            emittedChunks += 1;
            callbacks.data(chunk);
          }
          if (!paused) callbacks.end();
          return this;
        },
      };
    },
  };
  const { fetchAndExtractZip } = await configureZip({
    entries: [['src/forged.bin', forgedEntry]],
  });

  await assert.rejects(() => fetchAndExtractZip('demo', 'CODE.zip'), { message: SAFETY_ERROR });
  assert.equal(emittedChunks, ZIP_LIMITS.minExpandedBytes / MB + 1);
  assert.equal(paused, true);
});

test('rejects an underreported total while extracting sequentially', async () => {
  const sharedMegabyte = new ArrayBuffer(MB);
  const entries = Array.from({ length: ZIP_LIMITS.minExpandedBytes / MB + 1 }, (_, index) => [
    `src/underreported-${index}.bin`,
    fakeEntry({ size: 1, extract: async () => sharedMegabyte }),
  ]);
  const { fetchAndExtractZip } = await configureZip({ entries });

  await assert.rejects(() => fetchAndExtractZip('demo', 'CODE.zip'), { message: SAFETY_ERROR });
});
