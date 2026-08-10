import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function serviceWorkerHarness() {
  const handlers = new Map();
  const stored = new Map();
  const cache = {
    async put(request, response) { stored.set(request.url, response.clone()); },
    async match(request) { return stored.get(request.url)?.clone(); },
  };
  const self = {
    registration: { scope: 'https://gallery.test/' },
    location: { origin: 'https://gallery.test' },
    clients: { async claim() {} },
    async skipWaiting() {},
    addEventListener(type, handler) { handlers.set(type, handler); },
  };
  const context = vm.createContext({
    URL,
    Request,
    Response,
    Object,
    console,
    fetch: async () => { throw new Error('unexpected network request'); },
    caches: {
      async delete() { stored.clear(); return true; },
      async open() { return cache; },
    },
    self,
  });
  const source = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
  vm.runInContext(source, context, { filename: 'public/sw.js' });

  return {
    async load(files) {
      let work;
      handlers.get('message')({
        data: { type: 'load', files },
        ports: [{ postMessage() {} }],
        waitUntil(promise) { work = promise; },
      });
      await work;
    },
    async request(path) {
      let response;
      handlers.get('fetch')({
        request: new Request(`https://gallery.test/${path}`),
        respondWith(promise) { response = promise; },
      });
      return response;
    },
  };
}

test('preview documents, cached assets, and 404 responses satisfy credentialless COEP', async () => {
  const sw = await serviceWorkerHarness();
  await sw.load({
    'index.html': new TextEncoder().encode('<h1>Preview</h1>').buffer,
    'app.js': new TextEncoder().encode('window.preview = true;').buffer,
  });

  const html = await sw.request('__preview__/index.html');
  assert.equal(html.headers.get('Cross-Origin-Embedder-Policy'), 'credentialless');
  assert.equal(html.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(html.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(await html.text(), '<h1>Preview</h1>');

  const script = await sw.request('__preview__/app.js');
  assert.equal(script.headers.get('Cross-Origin-Embedder-Policy'), 'credentialless');
  assert.equal(script.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(script.headers.get('Content-Type'), 'text/javascript; charset=utf-8');
  assert.equal(await script.text(), 'window.preview = true;');

  const missing = await sw.request('__preview__/missing.html');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Cross-Origin-Embedder-Policy'), 'credentialless');
  assert.equal(missing.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
});
