import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  publishStaticArtifact,
  resolveStaticPreviewArtifact,
} from './preview-artifacts.mjs';

const build = {
  status: 'ready',
  outputDir: 'C:/tmp/dist',
  preview: {
    mode: 'static',
    runtime: 'vite-react',
    sourceHash: 'sha256:abc',
    artifactBase: 'previews/sha256:abc/',
    entry: 'index.html',
    status: 'ready',
    builderVersion: 3,
    failureCode: null,
  },
};

function missingObject() {
  return Object.assign(new Error('Not Found'), { stderr: 'An error occurred (404) when calling HeadObject' });
}

test('completed artifacts are reused before the build callback runs', async () => {
  let builds = 0;
  const result = await resolveStaticPreviewArtifact({
    sourceHash: 'sha256:abc',
    reusedBuild: { ...build, outputDir: null },
    build: async () => { builds += 1; return build; },
    bucket: 'gallery',
    endpoint: 'https://r2.example',
    runAws: async () => Buffer.from('{}'),
  });

  assert.equal(builds, 0);
  assert.equal(result.outputDir, null);
  assert.equal(result.preview.status, 'ready');
});

test('publishing clears incomplete files and writes the completion manifest last', async () => {
  const calls = [];
  let completion;
  await publishStaticArtifact({
    build,
    bucket: 'gallery',
    endpoint: 'https://r2.example',
    runAws: async (args) => {
      calls.push(args);
      if (args[0] === 's3api' && args[1] === 'head-object'
        && args.some((arg) => arg.endsWith('/.complete.json'))) {
        throw missingObject();
      }
      if (args[0] === 's3api' && args[1] === 'put-object') {
        completion = JSON.parse(readFileSync(args[args.indexOf('--body') + 1], 'utf8'));
      }
      return Buffer.alloc(0);
    },
  });

  assert.deepEqual(calls.map((args) => `${args[0]} ${args[1]}`), [
    's3api head-object',
    's3 rm',
    's3 cp',
    's3api head-object',
    's3api put-object',
  ]);
  assert.equal(calls.at(-1).includes('previews/sha256:abc/.complete.json'), true);
  assert.deepEqual(completion, {
    schemaVersion: 1,
    sourceHash: 'sha256:abc',
    runtime: 'vite-react',
    entry: 'index.html',
    builderVersion: 3,
  });
});

test('publishing never mutates a prefix that already has a completion manifest', async () => {
  const calls = [];
  const result = await publishStaticArtifact({
    build,
    bucket: 'gallery',
    endpoint: 'https://r2.example',
    runAws: async (args) => { calls.push(args); return Buffer.from('{}'); },
  });

  assert.equal(result.reused, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['s3api', 'head-object']);
});

test('a completion lookup outage aborts instead of risking an overwrite', async () => {
  const calls = [];
  await assert.rejects(
    publishStaticArtifact({
      build,
      bucket: 'gallery',
      endpoint: 'https://r2.example',
      runAws: async (args) => {
        calls.push(args);
        throw Object.assign(new Error('Service unavailable'), { stderr: '503 ServiceUnavailable' });
      },
    }),
    /Service unavailable/,
  );
  assert.equal(calls.length, 1);
});
