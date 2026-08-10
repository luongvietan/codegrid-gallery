# Static Template Preview Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify package-based templates accurately, prebuild Vite and Create React App projects once in isolated CI containers, publish content-addressed static artifacts to R2, and render those artifacts locally and in production without downloading the source ZIP.

**Architecture:** The sync pipeline inspects each ZIP, derives a precise runtime profile, and runs eligible builds inside secret-free Docker containers. Successful output is uploaded as individual immutable R2 objects and described by a `preview` manifest in `data/index.json`; the gallery selects a dedicated static iframe loader when that manifest is ready. Existing HTML preview behavior remains unchanged, and Next.js projects are marked `runtime-required` for the next implementation plan.

**Tech Stack:** Node.js 20 ESM scripts, Node test runner, Docker `node:20-bookworm-slim`, npm/pnpm, Vite/CRA, AWS CLI against Cloudflare R2, Next.js 16 App Router, React 19, TypeScript.

## Global Constraints

- Treat every template and package as untrusted code.
- Never expose Discord, R2, Vercel, GitHub, or gallery environment variables to install or build processes.
- Run install and build commands in disposable Docker containers with only the project directory and a dedicated package cache mounted.
- Disable package lifecycle scripts on the automatic build path.
- Build with no network after dependency installation.
- Reject ZIP path traversal, symbolic links, more than 10,000 entries, or more than 750 MiB declared expanded bytes.
- Limit each install to 8 minutes and each build to 5 minutes, with 2 GiB memory, 2 CPUs, and 256 processes.
- Use content-addressed R2 prefixes and immutable one-year cache headers for successful artifacts.
- Preserve the current HTML Service Worker preview throughout this phase.
- Do not attempt a Next.js build in this phase; mark Next.js as `runtime-required`.
- Follow red-green-refactor TDD for every production change and run the complete verification suite before merging.

---

## File Structure

### New files

- `scripts/preview-classifier.mjs`: ZIP central-directory inspection, manifest extraction, runtime classification, archive safety validation, and project type mapping.
- `scripts/preview-classifier.test.mjs`: classifier and unsafe-archive unit tests.
- `scripts/preview-builder.mjs`: source hashing, Docker command construction, isolated install/build execution, output discovery, and build result creation.
- `scripts/preview-builder.test.mjs`: source-hash, command-selection, isolation, timeout, and result tests using an injected process runner.
- `scripts/backfill-previews.mjs`: bounded migration of existing projects missing preview metadata.
- `scripts/backfill-previews.test.mjs`: selection, cursor, result merge, and failure-continuation tests.
- `.github/workflows/preview-backfill.yml`: manually dispatched, bounded backfill workflow.
- `lib/preview.ts`: browser-facing preview manifest types, mode selection, and static preview URL construction.
- `lib/preview.test.mjs`: pure preview-selection and URL tests.
- `components/tabs/StaticPreviewTab.tsx`: toolbar and sandboxed iframe for a ready static artifact.

### Modified files

- `scripts/sync-lib.mjs`: accept runtime and preview metadata when building and merging project records.
- `scripts/sync-lib.test.mjs`: cover new project entry and merge behavior.
- `scripts/ci-sync.mjs`: classify the downloaded ZIP, invoke the static builder, upload artifact files, and persist the preview manifest.
- `.github/workflows/daily-sync.yml`: run all pipeline tests and ensure Docker/AWS prerequisites before sync.
- `lib/types.ts`: add runtime and preview manifest types to `Project`.
- `lib/assets.ts`: construct the fixed public R2 URL for content-addressed preview artifacts.
- `components/ProjectModal.tsx`: expose static Preview for ready artifacts and load ZIP only for Code or legacy HTML Preview.
- `app/globals.css`: add status styles only if `StaticPreviewTab` cannot reuse the existing preview toolbar classes.
- `package.json`: add a single `test:pipeline` script covering all Node pipeline tests.

---

### Task 1: ZIP Inspection and Runtime Classification

**Files:**
- Create: `scripts/preview-classifier.mjs`
- Create: `scripts/preview-classifier.test.mjs`
- Modify: `scripts/sync-lib.mjs`
- Modify: `scripts/sync-lib.test.mjs`

**Interfaces:**
- Consumes: a ZIP `Buffer` already downloaded by `scripts/ci-sync.mjs`.
- Produces: `inspectTemplateArchive(zipBuffer): ArchiveInspection` and `projectTypeForRuntime(runtime): 'html' | 'react' | 'nextjs'`.
- `ArchiveInspection` shape: `{ names, records, root, runtime, packageManager, installCommand, devCommand, buildCommand, frameworkVersion }`.

- [ ] **Step 1: Write failing classifier tests**

Add table-driven tests that pass synthetic filenames plus parsed package content into the pure classifier seam:

```js
test('classifyRuntime distinguishes the five supported profiles', () => {
  assert.equal(classifyRuntime(['index.html'], null), 'html');
  assert.equal(classifyRuntime(['demo/package.json'], { dependencies: { vite: '^7.0.0' } }), 'vite-vanilla');
  assert.equal(classifyRuntime(['demo/package.json'], { dependencies: { vite: '^7.0.0', react: '^19.0.0' } }), 'vite-react');
  assert.equal(classifyRuntime(['demo/package.json'], { dependencies: { 'react-scripts': '5.0.1' } }), 'cra');
  assert.equal(classifyRuntime(['demo/package.json'], { dependencies: { next: '16.0.1' } }), 'nextjs');
});

test('next dependency wins even without next.config', () => {
  assert.equal(classifyRuntime(['demo/package.json'], { dependencies: { next: '14.2.0', react: '^18' } }), 'nextjs');
});

test('archive validation rejects traversal and symlinks', () => {
  assert.throws(() => validateArchiveRecords([{ name: '../escape.js', uncompressedSize: 1, unixMode: 0 }]), /unsafe path/i);
  assert.throws(() => validateArchiveRecords([{ name: 'demo/link', uncompressedSize: 1, unixMode: 0o120777 }]), /symbolic link/i);
});
```

- [ ] **Step 2: Run tests and confirm the red state**

Run: `node --test scripts/preview-classifier.test.mjs scripts/sync-lib.test.mjs`

Expected: FAIL because `preview-classifier.mjs`, `classifyRuntime`, and `validateArchiveRecords` do not exist.

- [ ] **Step 3: Implement central-directory records and pure classification**

Implement the exported API with explicit constants and no filesystem I/O:

```js
export const RUNTIMES = ['html', 'vite-vanilla', 'vite-react', 'cra', 'nextjs', 'unsupported'];

export function classifyRuntime(names, pkg) {
  if (!pkg) return names.some((name) => /(^|\/)index\.html$/i.test(name)) ? 'html' : 'unsupported';
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (deps.next) return 'nextjs';
  if (deps['react-scripts']) return 'cra';
  if (deps.vite) return deps.react || deps['@vitejs/plugin-react'] ? 'vite-react' : 'vite-vanilla';
  return 'unsupported';
}

export function projectTypeForRuntime(runtime) {
  if (runtime === 'nextjs') return 'nextjs';
  if (runtime === 'html') return 'html';
  return 'react';
}
```

The broad `type` field remains backward-compatible with the existing HTML/React/Next filters: all package-based Vite/CRA projects stay in the React bucket, while the new `runtime` field carries the accurate profile. The misclassified Next.js project moves to the Next bucket.

Extend the existing central-directory parser to retain compression method, compressed and uncompressed sizes, local header offset, and Unix mode. Validate all records before reading `package.json`. Inflate only the shallowest non-`node_modules` package manifest with `node:zlib.inflateRawSync`.

- [ ] **Step 4: Add command and root detection**

Return exact commands:

```js
const packageManager = names.some((name) => name === `${root}pnpm-lock.yaml`)
  ? 'pnpm'
  : 'npm';
const installCommand = packageManager === 'pnpm'
  ? ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']
  : names.includes(`${root}package-lock.json`)
    ? ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']
    : ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'];
```

Set `buildCommand` to `['npx', '--no-install', 'vite', 'build', '--base=./']` for Vite and `['npm', 'run', 'build']` for CRA. Next.js and unsupported profiles return `buildCommand: null`.

- [ ] **Step 5: Update sync helpers to accept the inspection result**

Change `buildProjectEntry` to consume `runtime` and `preview`, while retaining the public `type` field:

```js
export function buildProjectEntry({ msg, folder, runtime, preview, entryHtml, attachments }) {
  return {
    id: slug(folder),
    folder,
    title: prettyTitle(folder),
    type: projectTypeForRuntime(runtime),
    runtime,
    preview,
    date: (msg.timestamp || '').slice(0, 10) || null,
    author: msg.author?.username ?? null,
    msgId: msg.id,
    thumbnail: pickThumbnail(attachments.images),
    video: attachments.videos[0]?.filename ?? null,
    zip: attachments.zips[0]?.filename ?? null,
    entryHtml,
    media: {
      images: attachments.images,
      videos: attachments.videos,
      zips: attachments.zips,
    },
  };
}
```

Import `projectTypeForRuntime` from `preview-classifier.mjs`; remove the old filename-only `classify` export after all tests and callers are migrated.

- [ ] **Step 6: Verify green and commit**

Run: `node --test scripts/preview-classifier.test.mjs scripts/sync-lib.test.mjs`

Expected: all classifier and sync helper tests PASS.

```bash
git add scripts/preview-classifier.mjs scripts/preview-classifier.test.mjs scripts/sync-lib.mjs scripts/sync-lib.test.mjs
git commit -m "feat: classify template runtimes from package manifests"
```

---

### Task 2: Preview Manifest Contracts and Browser Selection

**Files:**
- Create: `lib/preview.ts`
- Create: `lib/preview.test.mjs`
- Modify: `lib/types.ts`
- Modify: `lib/assets.ts`

**Interfaces:**
- Consumes: `Project.preview` and `Project.runtime` from Task 1.
- Produces: `hasReadyPreview(project): boolean`, `previewKind(project): 'legacy-html' | 'static' | 'none'`, and `staticPreviewUrl(preview): string`.

- [ ] **Step 1: Write failing manifest tests**

```js
test('ready static manifest selects static preview without a ZIP', () => {
  const project = { type: 'react', preview: { mode: 'static', status: 'ready', sourceHash: 'sha256:abc', entry: 'index.html' } };
  assert.equal(previewKind(project), 'static');
  assert.equal(hasReadyPreview(project), true);
});

test('legacy HTML remains available', () => {
  assert.equal(previewKind({ type: 'html', entryHtml: 'demo/index.html' }), 'legacy-html');
});

test('static URL encodes hash and path segments', () => {
  assert.equal(
    staticPreviewUrl({ sourceHash: 'sha256:abc', entry: 'nested/index.html' }),
    'https://pub-x.r2.dev/previews/sha256%3Aabc/nested/index.html',
  );
});
```

- [ ] **Step 2: Run tests and confirm the red state**

Run: `node --test lib/preview.test.mjs`

Expected: FAIL because `lib/preview.ts` does not exist.

- [ ] **Step 3: Define exact TypeScript contracts**

Add to `lib/types.ts`:

```ts
export type RuntimeProfile = 'html' | 'vite-vanilla' | 'vite-react' | 'cra' | 'nextjs' | 'unsupported';
export type PreviewMode = 'html' | 'static' | 'webcontainer' | 'vercel' | 'unavailable';
export type PreviewStatus = 'ready' | 'build-failed' | 'runtime-required' | 'unsupported';

export interface PreviewManifest {
  mode: PreviewMode;
  runtime: RuntimeProfile;
  sourceHash: string | null;
  artifactBase: string | null;
  entry: string | null;
  status: PreviewStatus;
  builderVersion: number;
  failureCode: string | null;
}
```

Add `runtime?: RuntimeProfile` and `preview?: PreviewManifest` to `Project` so old index entries remain readable during migration.

- [ ] **Step 4: Implement selection and URL helpers**

Reuse the fixed-base, segment-by-segment encoding in `assetUrl` and reject incomplete manifests:

```ts
export function previewKind(project: Pick<Project, 'type' | 'entryHtml' | 'preview'>) {
  if (project.preview?.mode === 'static' && project.preview.status === 'ready' && project.preview.sourceHash && project.preview.entry) return 'static';
  if (project.type === 'html' && project.entryHtml) return 'legacy-html';
  return 'none';
}

export function staticPreviewUrl(preview: Pick<PreviewManifest, 'sourceHash' | 'entry'>) {
  if (!preview.sourceHash || !preview.entry) throw new Error('Static preview manifest is incomplete');
  return assetUrl(`previews/${preview.sourceHash}`, preview.entry);
}
```

Set `process.env.NEXT_PUBLIC_ASSET_BASE = 'https://pub-x.r2.dev'` before dynamically importing `lib/preview.ts` in the test, matching the existing `lib/assets.test.ts` pattern.

- [ ] **Step 5: Verify green and commit**

Run: `node --test lib/preview.test.mjs`

Expected: all preview contract tests PASS.

```bash
git add lib/types.ts lib/assets.ts lib/preview.ts lib/preview.test.mjs
git commit -m "feat: define static preview manifest contracts"
```

---

### Task 3: Isolated Static Builder

**Files:**
- Create: `scripts/preview-builder.mjs`
- Create: `scripts/preview-builder.test.mjs`

**Interfaces:**
- Consumes: `ArchiveInspection` from Task 1 plus ZIP path and temporary directory.
- Produces: `sourceHash(zipBuffer, runtime, builderVersion?)`, `dockerInvocation(phase, inspection, paths)`, and `buildStaticPreview(options): Promise<BuildResult>`.
- `BuildResult`: `{ status, outputDir, preview, log }`, with logs capped at 64 KiB.

- [ ] **Step 1: Write failing source-hash and Docker isolation tests**

```js
test('source hash changes with builder version or runtime', () => {
  const zip = Buffer.from('same source');
  assert.notEqual(sourceHash(zip, 'vite-vanilla', 1), sourceHash(zip, 'vite-vanilla', 2));
  assert.notEqual(sourceHash(zip, 'vite-vanilla', 1), sourceHash(zip, 'vite-react', 1));
});

test('build container has no network and no secret environment forwarding', () => {
  const args = dockerInvocation('build', inspection, paths).args;
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('--memory=2g'));
  assert.ok(args.includes('--cpus=2'));
  assert.ok(args.includes('--pids-limit=256'));
  assert.equal(args.some((arg) => /DISCORD|R2_|VERCEL|GITHUB_TOKEN/.test(arg)), false);
});

test('Vite output uses a relative base', () => {
  const args = dockerInvocation('build', viteInspection, paths).args;
  assert.deepEqual(args.slice(-5), ['npx', '--no-install', 'vite', 'build', '--base=./']);
});
```

- [ ] **Step 2: Run tests and confirm the red state**

Run: `node --test scripts/preview-builder.test.mjs`

Expected: FAIL because the builder module does not exist.

- [ ] **Step 3: Implement stable hashing and Docker argument construction**

Use SHA-256 over source bytes and exact version labels:

```js
export const BUILDER_VERSION = 1;

export function sourceHash(zipBuffer, runtime, builderVersion = BUILDER_VERSION) {
  return `sha256:${createHash('sha256')
    .update(`builder:${builderVersion}\nruntime:${runtime}\n`)
    .update(zipBuffer)
    .digest('hex')}`;
}
```

Construct Docker arguments without a host shell:

```js
const limits = ['--memory=2g', '--cpus=2', '--pids-limit=256'];
const mounts = phase === 'install'
  ? ['-v', `${projectDir}:/workspace`, '-v', `${cacheDir}:/root/.npm`, '-w', '/workspace']
  : ['-v', `${projectDir}:/workspace`, '-w', '/workspace'];
const network = phase === 'install' ? ['--network=bridge'] : ['--network=none'];
return { file: 'docker', args: ['run', '--rm', ...limits, ...network, ...mounts, 'node:20-bookworm-slim', ...command] };
```

For CRA build containers add `-e`, `PUBLIC_URL=.`. Do not pass the host `env` object to Docker; pass only `PATH`, `SystemRoot`, `TEMP`, and `TMP` to the host `execFile` call.

- [ ] **Step 4: Write the failing orchestrator test**

Inject `runProcess` and assert exact phase order and fallback behavior:

```js
test('builder installs then builds and returns a ready manifest', async () => {
  const calls = [];
  const runProcess = async (invocation) => { calls.push(invocation.phase); return { code: 0, stdout: '', stderr: '' }; };
  const result = await buildStaticPreview({ inspection: viteInspection, zipBuffer, projectDir, cacheDir, runProcess, outputExists: () => true });
  assert.deepEqual(calls, ['install', 'build']);
  assert.equal(result.preview.mode, 'static');
  assert.equal(result.preview.status, 'ready');
  assert.equal(result.preview.entry, 'index.html');
});

test('failed build becomes runtime-required without throwing', async () => {
  const runProcess = async ({ phase }) => phase === 'install' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'config failed' };
  const result = await buildStaticPreview({ inspection: viteInspection, zipBuffer, projectDir, cacheDir, runProcess });
  assert.equal(result.preview.status, 'build-failed');
  assert.equal(result.preview.mode, 'webcontainer');
  assert.equal(result.preview.failureCode, 'build-failed');
});
```

- [ ] **Step 5: Implement orchestration, timeouts, and bounded logs**

Use `node:child_process.execFile` through `promisify`, with `timeout: 480_000` for install and `300_000` for build. Set `maxBuffer: 64 * 1024`; normalize timeout to `install-failed` or `build-failed` and never include more than the final 4 KiB in the public result.

Return `runtime-required` immediately for Next.js, and `unsupported` for unsupported profiles. Vite output is `<projectDir>/dist`; CRA output is `<projectDir>/build`.

- [ ] **Step 6: Verify green and commit**

Run: `node --test scripts/preview-builder.test.mjs`

Expected: all builder tests PASS with no Docker process started because the runner is injected.

```bash
git add scripts/preview-builder.mjs scripts/preview-builder.test.mjs
git commit -m "feat: build static previews in isolated containers"
```

---

### Task 4: Daily Sync Integration and Artifact Upload

**Files:**
- Modify: `scripts/ci-sync.mjs`
- Modify: `scripts/sync-lib.mjs`
- Modify: `scripts/sync-lib.test.mjs`
- Modify: `.github/workflows/daily-sync.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: classifier and builder results from Tasks 1 and 3.
- Produces: R2 objects at `previews/<encoded-source-hash>/<file>` and populated project preview metadata.

- [ ] **Step 1: Write failing pure upload-plan tests**

Extract and test a pure helper:

```js
test('artifactUploadArgs sets immutable cache and content-addressed prefix', () => {
  const args = artifactUploadArgs('C:/tmp/dist', 'sha256:abc');
  assert.deepEqual(args, [
    's3', 'cp', 'C:/tmp/dist', 's3://codegrid-gallery/previews/sha256:abc',
    '--recursive', '--cache-control', 'public,max-age=31536000,immutable',
    '--endpoint-url', 'https://r2.example',
  ]);
});

test('retryDelayMs honors Retry-After and adds bounded exponential jitter', () => {
  assert.equal(retryDelayMs(2, 7_000, () => 0), 7_000);
  assert.equal(retryDelayMs(2, null, () => 0), 4_000);
  assert.equal(retryDelayMs(2, null, () => 1), 5_000);
});
```

Place `artifactUploadArgs` in `scripts/sync-lib.mjs` with bucket and endpoint passed explicitly so tests do not depend on environment variables.

- [ ] **Step 2: Run the pipeline tests and confirm the red state**

Run: `node --test scripts/preview-classifier.test.mjs scripts/preview-builder.test.mjs scripts/sync-lib.test.mjs`

Expected: FAIL because `artifactUploadArgs` is missing and `ci-sync.mjs` still calls the old classifier.

- [ ] **Step 3: Integrate classification, safe extraction, and build**

In `ci-sync.mjs`, after downloading the ZIP:

```js
const zipPath = path.join(dir, att.zips[0].filename);
const zipBuffer = fs.readFileSync(zipPath);
const inspection = inspectTemplateArchive(zipBuffer);
validateArchiveRecords(inspection.records);
const projectDir = path.join(tmp, 'source');
extractValidatedArchive(zipPath, projectDir, inspection.records);
const build = await buildStaticPreview({
  inspection,
  zipBuffer,
  projectDir: path.join(projectDir, inspection.root),
  cacheDir: path.join(os.tmpdir(), 'codegrid-npm-cache'),
});
```

`extractValidatedArchive` must call `unzip -q <zipPath> -d <projectDir>` only after validation. It must use `execFileSync`, not a shell command string.

Wrap inspection, validation, extraction, and build in a per-project error boundary. Map validation exceptions to `archive-invalid` or `archive-too-large`, persist an `unavailable` preview manifest, upload the original attachments, and continue to the next candidate. No malformed project may abort the full daily batch.

Add `PREVIEW_BUILD_ENABLED`; when it is exactly `false`, classification still runs but Vite/CRA projects receive `mode: 'webcontainer'`, `status: 'runtime-required'`, and `failureCode: null` without starting Docker. The workflow sets it to `true`; the flag is a production rollback control.

- [ ] **Step 4: Upload successful artifacts and persist the manifest**

When `build.preview.status === 'ready'`, upload `build.outputDir` to the content-addressed prefix and verify `index.html` exists with `aws s3api head-object`. Then call:

```js
buildProjectEntry({
  msg,
  folder,
  runtime: inspection.runtime,
  preview: build.preview,
  entryHtml: pickEntryHtml(inspection.names),
  attachments: att,
});
```

When build status is not ready, still upload the original source attachments and persist the fallback manifest so one broken template never aborts the daily sync.

Update attachment and R2 retry loops to use `retryDelayMs` for HTTP 429 and transient 5xx responses. Cap retries at five and honor an upstream `Retry-After` value before applying exponential backoff with up to one second of jitter.

- [ ] **Step 5: Update workflow tests and commands**

Add to `package.json`:

```json
"test:pipeline": "node --test scripts/preview-classifier.test.mjs scripts/preview-builder.test.mjs scripts/sync-lib.test.mjs lib/preview.test.mjs"
```

Change the workflow unit-test step to `npm run test:pipeline`. Add a prerequisite step that prints `docker --version`, `unzip -v | head -1`, and `aws --version` so missing runner tools fail before downloading an attachment.

- [ ] **Step 6: Verify green and commit**

Run:

```bash
npm run test:pipeline
node --check scripts/ci-sync.mjs
```

Expected: all pipeline tests PASS and `ci-sync.mjs` syntax check exits 0.

```bash
git add scripts/ci-sync.mjs scripts/sync-lib.mjs scripts/sync-lib.test.mjs .github/workflows/daily-sync.yml package.json
git commit -m "feat: publish static previews during daily sync"
```

---

### Task 5: Incremental Backfill for Existing Projects

**Files:**
- Create: `scripts/backfill-previews.mjs`
- Create: `scripts/backfill-previews.test.mjs`
- Create: `.github/workflows/preview-backfill.yml`

**Interfaces:**
- Consumes: existing `data/index.json`, fixed R2 objects, Tasks 1-4 classifier/builder/upload helpers.
- Produces: at most `limit` updated project records per run; default limit is 3 and maximum is 10.

- [ ] **Step 1: Write failing selection and continuation tests**

```js
test('selectBackfillBatch skips ready and Next runtime entries', () => {
  const projects = [
    { id: 'a', preview: { status: 'ready' } },
    { id: 'b', runtime: 'nextjs' },
    { id: 'c', type: 'react' },
    { id: 'd', type: 'react' },
  ];
  assert.deepEqual(selectBackfillBatch(projects, 1).map((p) => p.id), ['c']);
});

test('mergeBackfillResults preserves a failed project and continues', () => {
  const merged = mergeBackfillResults([{ id: 'a' }, { id: 'b' }], [
    { id: 'a', preview: { status: 'build-failed', failureCode: 'build-failed' } },
    { id: 'b', preview: { status: 'ready' } },
  ]);
  assert.equal(merged[0].preview.status, 'build-failed');
  assert.equal(merged[1].preview.status, 'ready');
});
```

- [ ] **Step 2: Run tests and confirm the red state**

Run: `node --test scripts/backfill-previews.test.mjs`

Expected: FAIL because the backfill module does not exist.

- [ ] **Step 3: Implement bounded selection and atomic index writes**

Parse `--limit` as an integer in `[1, 10]`, defaulting to 3. Select projects without a ready preview in stable folder order. Download each ZIP with authenticated `aws s3 cp`, run the same classifier/builder, upload ready artifacts, and store failure metadata without stopping the batch.

Write `data/index.json.tmp`, then rename it over the index only after the entire selected batch is processed.

- [ ] **Step 4: Add the manual workflow**

Create `preview-backfill.yml` with `workflow_dispatch.inputs.limit`, default `3`, concurrency group `preview-backfill`, Node 20 setup, full pipeline tests, and the same six R2/Discord environment variables used by daily sync. Its final commit step stages only `data/index.json` and uses commit message `data: backfill static preview metadata`.

Extend `test:pipeline` to include `scripts/backfill-previews.test.mjs` after that file exists.

- [ ] **Step 5: Verify green and commit**

Run:

```bash
node --test scripts/backfill-previews.test.mjs
node --check scripts/backfill-previews.mjs
```

Expected: tests PASS and syntax check exits 0.

```bash
git add scripts/backfill-previews.mjs scripts/backfill-previews.test.mjs .github/workflows/preview-backfill.yml
git commit -m "feat: backfill static preview artifacts incrementally"
```

---

### Task 6: Static Preview UI and Lazy ZIP Loading

**Files:**
- Create: `components/tabs/StaticPreviewTab.tsx`
- Modify: `components/ProjectModal.tsx`
- Modify: `app/globals.css` only if existing toolbar classes are insufficient
- Test: `lib/preview.test.mjs`

**Interfaces:**
- Consumes: `previewKind(project)` and `staticPreviewUrl(project.preview)` from Task 2.
- Produces: a preview tab for static artifacts that never calls `fetchAndExtractZip` unless the user opens Code.

- [ ] **Step 1: Add a failing lazy-load policy test**

Add a pure helper to the desired API:

```js
test('ZIP is not required for a static preview or media tab', () => {
  assert.equal(needsSourceZip('preview', 'static'), false);
  assert.equal(needsSourceZip('media', 'static'), false);
  assert.equal(needsSourceZip('code', 'static'), true);
  assert.equal(needsSourceZip('preview', 'legacy-html'), true);
});
```

- [ ] **Step 2: Run the test and confirm the red state**

Run: `node --test lib/preview.test.mjs`

Expected: FAIL because `needsSourceZip` is missing.

- [ ] **Step 3: Implement the policy and static tab**

Add:

```ts
export function needsSourceZip(tab: 'preview' | 'code' | 'media', kind: 'legacy-html' | 'static' | 'none') {
  return tab === 'code' || (tab === 'preview' && kind === 'legacy-html');
}
```

`StaticPreviewTab` sets the iframe source directly, reuses `.preview-toolbar`, `.iframe-wrap`, and `.ghost`, and provides Refresh and New Tab actions. Keep the iframe sandbox equal to the current HTML preview sandbox.

- [ ] **Step 4: Refactor ProjectModal to fetch lazily**

Derive `kind = previewKind(p)` and `hasPreview = kind !== 'none'`. Move ZIP fetching into an effect guarded by `needsSourceZip(tab, kind) && !zip && !loading`. Render:

```tsx
{tab === 'preview' && kind === 'static' && p.preview && <StaticPreviewTab preview={p.preview} />}
{tab === 'preview' && kind === 'legacy-html' && zip && <PreviewTab p={p} zip={zip} onToast={onToast} />}
```

Media must continue to render from project metadata without loading the ZIP. Code triggers ZIP download on first open and reuses it until the modal closes.

- [ ] **Step 5: Verify unit tests and source lint**

Run:

```bash
node --test lib/preview.test.mjs
npx eslint components/ProjectModal.tsx components/tabs/StaticPreviewTab.tsx lib/preview.ts
```

Expected: tests PASS and ESLint exits 0.

- [ ] **Step 6: Perform browser QA locally**

Keep the existing dev server on port 3010. Using the in-app browser:

1. Open an existing HTML template and verify Preview still loads CSS/scripts.
2. Use a test index entry with a ready static artifact and verify opening Preview does not request `CODE.zip`.
3. Open Code and verify `CODE.zip` is then requested once.
4. Switch to Media and verify thumbnail/video metadata still renders.
5. Verify Refresh and New Tab load the same content-addressed URL.

- [ ] **Step 7: Commit**

```bash
git add components/ProjectModal.tsx components/tabs/StaticPreviewTab.tsx lib/preview.ts lib/preview.test.mjs app/globals.css
git commit -m "feat: render prebuilt static template previews"
```

---

### Task 7: End-to-End Verification and Phase Handoff

**Files:**
- Modify: `README.md`
- Modify: `.env.example` only if an existing required R2 variable is undocumented

**Interfaces:**
- Consumes: all Phase 1 components.
- Produces: verified documentation and a clean mergeable branch.

- [ ] **Step 1: Document preview modes and backfill operation**

Add concise README sections covering:

- HTML legacy preview.
- Static Vite/CRA artifact generation.
- `npm run test:pipeline`.
- Manual `preview-backfill` workflow with batch limit 1-10.
- `runtime-required` meaning that Next/WebContainer support belongs to the next phase.

- [ ] **Step 2: Run the full verification suite**

Run:

```bash
npm run test:pipeline
node --test lib/assets.test.ts lib/assets-default.test.ts lib/zip-proxy.test.mjs lib/preview-paths.test.mjs
node --check public/sw.js
npm run build
git diff --check
```

Expected: every test reports zero failures, service-worker syntax exits 0, Next production build exits 0, and `git diff --check` emits no errors.

- [ ] **Step 3: Verify the live development server remains available**

Run: `Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3010/ | Select-Object -ExpandProperty StatusCode`

Expected: `200`. Do not stop the process.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md .env.example
git commit -m "docs: document static preview pipeline"
```

- [ ] **Step 5: Merge and push according to the project rule**

If implementation ran on a feature branch, pull the latest `master`, merge only after the merged tree passes Step 2, then push `master`. If implementation ran directly on `master`, pull with rebase, repeat any verification affected by incoming commits, and push. Never force-push.

- [ ] **Step 6: Record the next phase boundary**

The next plan is `Next static-export attempt`; it consumes `PreviewManifest`, the content-addressed artifact uploader, and the static loader from this phase. It must not duplicate the classifier, proxy, or UI selection logic delivered here.
