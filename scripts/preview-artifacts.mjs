import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { artifactUploadArgs } from './sync-lib.mjs';

const COMPLETION_FILE = '.complete.json';
const IMMUTABLE_CACHE_CONTROL = 'public,max-age=31536000,immutable';

function completionKey(sourceHash) {
  return `previews/${sourceHash}/${COMPLETION_FILE}`;
}

function headArgs(sourceHash, bucket, endpoint) {
  return [
    's3api', 'head-object', '--bucket', bucket,
    '--key', completionKey(sourceHash),
    '--endpoint-url', endpoint,
  ];
}

function isMissingObject(error) {
  const detail = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join('\n');
  return /An error occurred \((?:404|NotFound|NoSuchKey)\)|\b(?:HTTP|status code:)\s*404\b/i.test(detail);
}

export async function completedArtifactExists({ sourceHash, bucket, endpoint, runAws }) {
  try {
    await runAws(headArgs(sourceHash, bucket, endpoint), { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch (error) {
    if (isMissingObject(error)) return false;
    throw error;
  }
}

export async function publishStaticArtifact({ build, bucket, endpoint, runAws }) {
  if (build?.preview?.mode !== 'static' || build.preview.status !== 'ready' || !build.outputDir) {
    throw new Error('Only a ready static preview with an output directory can be published');
  }
  const sourceHash = build.preview.sourceHash;
  if (await completedArtifactExists({ sourceHash, bucket, endpoint, runAws })) {
    return { reused: true };
  }

  await runAws([
    's3', 'rm', `s3://${bucket}/previews/${sourceHash}`,
    '--recursive', '--endpoint-url', endpoint,
  ], { stdio: ['ignore', 'inherit', 'pipe'] });
  await runAws(artifactUploadArgs(build.outputDir, sourceHash, bucket, endpoint), {
    stdio: ['ignore', 'inherit', 'pipe'],
  });
  await runAws([
    's3api', 'head-object', '--bucket', bucket,
    '--key', `previews/${sourceHash}/${build.preview.entry}`,
    '--endpoint-url', endpoint,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegrid-preview-complete-'));
  const manifestPath = path.join(temporaryDirectory, 'complete.json');
  try {
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      sourceHash,
      runtime: build.preview.runtime,
      entry: build.preview.entry,
      builderVersion: build.preview.builderVersion,
    }));
    await runAws([
      's3api', 'put-object', '--bucket', bucket,
      '--key', completionKey(sourceHash),
      '--body', manifestPath,
      '--content-type', 'application/json',
      '--cache-control', IMMUTABLE_CACHE_CONTROL,
      '--endpoint-url', endpoint,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return { reused: false };
}

export async function resolveStaticPreviewArtifact({
  sourceHash,
  reusedBuild,
  build,
  bucket,
  endpoint,
  runAws,
}) {
  if (await completedArtifactExists({ sourceHash, bucket, endpoint, runAws })) return reusedBuild;
  const result = await build();
  if (result?.preview?.mode === 'static' && result.preview.status === 'ready' && result.outputDir) {
    await publishStaticArtifact({ build: result, bucket, endpoint, runAws });
  }
  return result;
}
