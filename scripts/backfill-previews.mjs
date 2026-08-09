#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  inspectTemplateArchive,
  projectTypeForRuntime,
  validateArchiveRecords,
} from './preview-classifier.mjs';
import { BUILDER_VERSION, buildStaticPreview } from './preview-builder.mjs';
import {
  artifactUploadArgs,
  awsInvocationEnv,
  pickEntryHtml,
  retryDelayMs,
} from './sync-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = path.join(ROOT, 'data', 'index.json');
const MAX_ATTEMPTS = 5;

function validatedLimit(value) {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 10) {
    throw new Error('--limit must be an integer from 1 through 10');
  }
  return Number(value);
}

export function parseBackfillLimit(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { limit: { type: 'string', default: '3' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new Error('--limit must be an integer from 1 through 10');
  }
  return validatedLimit(values.limit);
}

export function selectBackfillBatch(projects, limit) {
  const boundedLimit = validatedLimit(String(limit));
  return projects
    .filter((project) => project.preview?.status !== 'ready')
    .filter((project) => project.runtime !== 'nextjs' && project.type !== 'nextjs')
    .map((project, position) => ({
      project,
      position,
      attemptPriority: project.preview == null ? 0 : 1,
    }))
    .sort((left, right) => {
      const leftFolder = String(left.project.folder ?? '');
      const rightFolder = String(right.project.folder ?? '');
      return left.attemptPriority - right.attemptPriority
        || (leftFolder < rightFolder ? -1 : leftFolder > rightFolder ? 1 : 0)
        || left.position - right.position;
    })
    .slice(0, boundedLimit)
    .map(({ project }) => project);
}

export function mergeBackfillResults(projects, results) {
  const updates = new Map(results.map((result) => [result.id, result]));
  return projects.map((project) => {
    const update = updates.get(project.id);
    return update ? { ...project, ...update } : project;
  });
}

function safeObjectSegment(value) {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && !/[\/\\\0-\x1f\x7f]/.test(value);
}

export function projectSourceDownloadArgs(project, destination, bucket, endpoint) {
  if (!safeObjectSegment(project.folder)
    || !safeObjectSegment(project.zip)
    || !project.zip.toLowerCase().endsWith('.zip')) {
    throw new Error('Project must have a safe indexed folder and ZIP filename');
  }
  return [
    's3', 'cp', `s3://${bucket}/${project.folder}/${project.zip}`, destination,
    '--endpoint-url', endpoint,
  ];
}

function failureResult(project, error) {
  return {
    id: project.id,
    preview: {
      mode: 'unavailable',
      runtime: error?.runtime ?? project.runtime ?? 'unsupported',
      sourceHash: error?.sourceHash ?? null,
      artifactBase: null,
      entry: null,
      status: 'build-failed',
      builderVersion: BUILDER_VERSION,
      failureCode: error?.failureCode ?? 'source-download-failed',
    },
  };
}

export async function processBackfillBatch(projects, processProject, onFailure = () => {}) {
  const results = [];
  for (const project of projects) {
    try {
      results.push(await processProject(project));
    } catch (error) {
      onFailure(project, error);
      results.push(failureResult(project, error));
    }
  }
  return results;
}

export function writeIndexAtomically(indexPath, index) {
  const temporaryPath = `${indexPath}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(index));
    fs.renameSync(temporaryPath, indexPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

function retryAfterErrorMs(error) {
  const detail = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join('\n');
  const match = detail.match(/(?:retry-after\s*[:=]|<RetryAfterSeconds>)\s*(\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) * 1_000 : null;
}

function isTransientAwsError(error) {
  const detail = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join('\n');
  return /\b(?:429|5\d\d)\b|SlowDown|Throttl|RequestTimeout|ServiceUnavailable|InternalError/i.test(detail);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function runAws(args, options = {}) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return execFileSync('aws', args, {
        env: awsInvocationEnv(process.env),
        windowsHide: true,
        ...options,
      });
    } catch (error) {
      if (attempt === MAX_ATTEMPTS - 1 || !isTransientAwsError(error)) throw error;
      await delay(retryDelayMs(attempt, retryAfterErrorMs(error)));
    }
  }
  throw new Error('R2 request failed after retries');
}

function taggedError(failureCode, error, inspection, sourceHash) {
  const tagged = new Error(error?.message || failureCode, { cause: error });
  tagged.failureCode = failureCode;
  tagged.runtime = inspection?.runtime;
  tagged.sourceHash = sourceHash;
  return tagged;
}

function archiveFailureCode(error) {
  return /too many entries|expanded size exceeds/i.test(error?.message || '')
    ? 'archive-too-large'
    : 'archive-invalid';
}

function extractValidatedArchive(zipPath, extractionDirectory, inspection) {
  validateArchiveRecords(inspection.records);
  fs.mkdirSync(extractionDirectory, { recursive: true });
  execFileSync('unzip', ['-q', zipPath, '-d', extractionDirectory], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
}

async function uploadReadyArtifact(build, bucket, endpoint) {
  await runAws(artifactUploadArgs(build.outputDir, build.preview.sourceHash, bucket, endpoint), {
    stdio: ['ignore', 'inherit', 'pipe'],
  });
  await runAws([
    's3api', 'head-object', '--bucket', bucket,
    '--key', `previews/${build.preview.sourceHash}/index.html`,
    '--endpoint-url', endpoint,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function processProject(project, bucket, endpoint) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegrid-backfill-'));
  const zipPath = path.join(temporaryDirectory, 'source.zip');
  let inspection;
  let build;

  try {
    await runAws(projectSourceDownloadArgs(project, zipPath, bucket, endpoint), {
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    const zipBuffer = fs.readFileSync(zipPath);

    try {
      inspection = inspectTemplateArchive(zipBuffer);
      extractValidatedArchive(zipPath, path.join(temporaryDirectory, 'source'), inspection);
    } catch (error) {
      throw taggedError(archiveFailureCode(error), error, inspection);
    }

    try {
      build = await buildStaticPreview({
        inspection,
        zipBuffer,
        projectDir: path.join(temporaryDirectory, 'source', inspection.root),
        cacheDir: path.join(os.tmpdir(), 'codegrid-npm-cache'),
      });
    } catch (error) {
      throw taggedError('build-failed', error, inspection);
    }

    if (build.preview.status === 'ready') {
      try {
        await uploadReadyArtifact(build, bucket, endpoint);
      } catch (error) {
        throw taggedError('artifact-upload-failed', error, inspection, build.preview.sourceHash);
      }
    }

    return {
      id: project.id,
      type: projectTypeForRuntime(inspection.runtime),
      runtime: inspection.runtime,
      entryHtml: pickEntryHtml(inspection.names),
      preview: build.preview,
    };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function updatedIndex(index, results, now = new Date()) {
  const projects = mergeBackfillResults(index.projects, results);
  const counts = projects.reduce((summary, project) => {
    summary[project.type] = (summary[project.type] || 0) + 1;
    return summary;
  }, {});
  return { ...index, generatedAt: now.toISOString(), counts, projects };
}

function requireEnvironment() {
  const required = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
}

function setChanged() {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'changed=true\n');
}

export async function main(argv = process.argv.slice(2)) {
  const limit = parseBackfillLimit(argv);
  requireEnvironment();
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const batch = selectBackfillBatch(index.projects, limit);

  console.log(`Selected ${batch.length} of at most ${limit} project(s) for preview backfill.`);
  if (batch.length === 0) return;

  const results = await processBackfillBatch(
    batch,
    (project) => processProject(project, process.env.R2_BUCKET, process.env.R2_ENDPOINT),
    (project, error) => console.error(`[PREVIEW] ${project.folder ?? project.id}: ${error.failureCode ?? 'source-download-failed'}`),
  );

  writeIndexAtomically(INDEX_PATH, updatedIndex(index, results));
  setChanged();
  console.log(`Backfilled ${results.length} project record(s).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[FATAL] ${error.message}`);
    process.exitCode = 1;
  });
}
