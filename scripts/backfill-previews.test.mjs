import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  mergeBackfillResults,
  parseBackfillLimit,
  processBackfillBatch,
  projectSourceDownloadArgs,
  selectBackfillBatch,
  writeIndexAtomically,
} from './backfill-previews.mjs';

test('selectBackfillBatch skips ready and Next runtime entries', () => {
  const projects = [
    { id: 'a', preview: { status: 'ready' } },
    { id: 'b', runtime: 'nextjs' },
    { id: 'c', type: 'react' },
    { id: 'd', type: 'react' },
  ];

  assert.deepEqual(selectBackfillBatch(projects, 1).map((project) => project.id), ['c']);
});

test('selectBackfillBatch uses stable folder order, skips known Next types, and keeps legacy package entries eligible', () => {
  const projects = [
    { id: 'later', folder: '2026-02_later', type: 'react' },
    { id: 'known-next', folder: '2026-01_next', type: 'nextjs' },
    { id: 'earlier-package', folder: '2026-01_package', type: 'react', entryHtml: null },
    { id: 'earlier-html', folder: '2026-01_html', type: 'html' },
  ];

  assert.deepEqual(
    selectBackfillBatch(projects, 3).map((project) => project.id),
    ['earlier-html', 'earlier-package', 'later'],
  );
});

test('selectBackfillBatch advances untouched projects before retrying an earlier failed batch', () => {
  let projects = [
    { id: 'a', folder: 'a', type: 'react' },
    { id: 'b', folder: 'b', type: 'react' },
    { id: 'c', folder: 'c', type: 'react' },
    { id: 'd', folder: 'd', type: 'react' },
  ];

  const firstBatch = selectBackfillBatch(projects, 2);
  assert.deepEqual(firstBatch.map((project) => project.id), ['a', 'b']);
  projects = mergeBackfillResults(projects, firstBatch.map((project) => ({
    id: project.id,
    preview: { status: 'build-failed', failureCode: 'build-failed' },
  })));

  const secondBatch = selectBackfillBatch(projects, 2);
  assert.deepEqual(secondBatch.map((project) => project.id), ['c', 'd']);
  projects = mergeBackfillResults(projects, secondBatch.map((project) => ({
    id: project.id,
    preview: { status: 'ready' },
  })));

  assert.deepEqual(selectBackfillBatch(projects, 2).map((project) => project.id), ['a', 'b']);
});

test('mergeBackfillResults preserves a failed project and continues', () => {
  const merged = mergeBackfillResults([{ id: 'a' }, { id: 'b' }], [
    { id: 'a', preview: { status: 'build-failed', failureCode: 'build-failed' } },
    { id: 'b', preview: { status: 'ready' } },
  ]);

  assert.equal(merged[0].preview.status, 'build-failed');
  assert.equal(merged[1].preview.status, 'ready');
});

test('mergeBackfillResults preserves existing project fields while applying classifier corrections', () => {
  const merged = mergeBackfillResults(
    [{ id: 'a', folder: 'folder-a', title: 'A', type: 'react' }],
    [{ id: 'a', type: 'nextjs', runtime: 'nextjs', preview: { status: 'runtime-required' } }],
  );

  assert.deepEqual(merged, [{
    id: 'a',
    folder: 'folder-a',
    title: 'A',
    type: 'nextjs',
    runtime: 'nextjs',
    preview: { status: 'runtime-required' },
  }]);
});

test('parseBackfillLimit defaults to 3 and accepts only integers from 1 through 10', () => {
  assert.equal(parseBackfillLimit([]), 3);
  assert.equal(parseBackfillLimit(['--limit', '1']), 1);
  assert.equal(parseBackfillLimit(['--limit=10']), 10);

  for (const argv of [['--limit', '0'], ['--limit', '11'], ['--limit', '2.5'], ['--limit', 'three']]) {
    assert.throws(() => parseBackfillLimit(argv), /--limit must be an integer from 1 through 10/);
  }
});

test('projectSourceDownloadArgs derives an authenticated fixed-bucket object key from the indexed record', () => {
  const project = {
    id: 'ignored-as-source',
    folder: '2026-01-02_Project Name',
    zip: 'CODE.zip',
    media: { zips: [{ url: 'https://untrusted.example/archive.zip' }] },
  };

  assert.deepEqual(
    projectSourceDownloadArgs(project, 'C:/tmp/source.zip', 'gallery', 'https://r2.example'),
    [
      's3', 'cp', 's3://gallery/2026-01-02_Project Name/CODE.zip', 'C:/tmp/source.zip',
      '--endpoint-url', 'https://r2.example',
    ],
  );
});

test('projectSourceDownloadArgs rejects unsafe or incomplete indexed object paths', () => {
  assert.throws(
    () => projectSourceDownloadArgs({ folder: '../escape', zip: 'CODE.zip' }, 'out.zip', 'gallery', 'https://r2.example'),
    /safe indexed folder and ZIP filename/,
  );
  assert.throws(
    () => projectSourceDownloadArgs({ folder: 'project', zip: 'nested/CODE.zip' }, 'out.zip', 'gallery', 'https://r2.example'),
    /safe indexed folder and ZIP filename/,
  );
  assert.throws(
    () => projectSourceDownloadArgs({ folder: 'project', zip: 'README.txt' }, 'out.zip', 'gallery', 'https://r2.example'),
    /safe indexed folder and ZIP filename/,
  );
});

test('processBackfillBatch persists a normalized failure and continues with later projects', async () => {
  const visited = [];
  const results = await processBackfillBatch(
    [{ id: 'a', type: 'react' }, { id: 'b', type: 'react' }],
    async (project) => {
      visited.push(project.id);
      if (project.id === 'a') throw new Error('R2 unavailable');
      return { id: project.id, preview: { status: 'ready' } };
    },
  );

  assert.deepEqual(visited, ['a', 'b']);
  assert.equal(results[0].preview.status, 'build-failed');
  assert.equal(results[0].preview.failureCode, 'source-download-failed');
  assert.equal(results[1].preview.status, 'ready');
});

test('writeIndexAtomically replaces the index and leaves no temporary file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegrid-backfill-test-'));
  const indexPath = path.join(directory, 'index.json');
  fs.writeFileSync(indexPath, '{"projects":[]}');

  try {
    writeIndexAtomically(indexPath, { generatedAt: 'now', projects: [{ id: 'a' }] });
    assert.deepEqual(JSON.parse(fs.readFileSync(indexPath, 'utf8')), {
      generatedAt: 'now',
      projects: [{ id: 'a' }],
    });
    assert.equal(fs.existsSync(`${indexPath}.tmp`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
