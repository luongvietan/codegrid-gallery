# Prebuild-First Template Preview Design

Date: 2026-08-10

## Objective

Render HTML, Vite, React, and Next.js template previews in both local and production environments while remaining within free-tier limits. Prefer work performed once during ingestion over repeated work in every visitor's browser. Preserve source fidelity and provide an explicit fallback when a template cannot be rendered statically.

## Repository Findings

The gallery contains 429 templates. Inspection of every ZIP central directory and every `package.json` produced these runtime profiles:

| Profile | Count | Share |
| --- | ---: | ---: |
| Static HTML | 224 | 52.2% |
| Vite vanilla JavaScript | 134 | 31.2% |
| Vite React | 3 | 0.7% |
| Create React App | 2 | 0.5% |
| Next.js | 66 | 15.4% |

The existing metadata reports 140 React and 65 Next.js projects because classification currently treats any archive containing `package.json` as React and requires a `next.config.*` file to identify Next.js. One Next.js archive has no matching config file and is therefore misclassified.

Additional common traits:

- All 205 package-based projects have a single top-level project directory.
- No package manifest declares a known native dependency such as `sharp`, `canvas`, SQLite, or `bcrypt`.
- The package manager split is 123 without a lockfile, 80 npm, and 2 pnpm.
- Common dependencies are GSAP in 164 projects, Lenis in 98, and Three.js in 29.
- Vite is present in 137 projects. All of them expose a Vite development command, although most do not define a build script.
- All 66 Next.js projects expose a Next development command; 11 explicitly select webpack.
- The package-based ZIPs total approximately 2.69 GB, so downloading a complete ZIP for each preview is materially more expensive than serving a built page's requested files.

A deeper source scan completed for 14 Next.js projects before the R2 origin began returning HTTP 429. Twelve of those projects were client-heavy and none used Server Actions, databases, `next/headers`, or native dependencies. This sample supports trying static export, but it is not used to assume that every Next.js project is static-compatible.

## Design Decision

Use a tiered preview system:

1. Serve existing HTML projects directly through the current Service Worker preview.
2. Build Vite and Create React App projects once during sync, then upload their extracted static output to R2.
3. Attempt a temporary static export for every Next.js project during sync. Upload the output only when the unmodified application source builds successfully with preview-specific configuration.
4. Run projects without a static artifact in a single reusable WebContainer instance in the visitor's browser.
5. Offer an on-demand Vercel Hobby deployment only when a project fails in WebContainer and the user explicitly requests the server preview.

This makes static delivery the normal path for at least 363 of 429 templates. WebContainer and Vercel are compatibility fallbacks rather than default infrastructure.

## System Boundaries

### 1. Runtime Classifier

The classifier reads archive filenames and `package.json` without extracting media files. It returns one of:

- `html`
- `vite-vanilla`
- `vite-react`
- `cra`
- `nextjs`
- `unsupported`

Classification rules use declared dependencies and scripts, not only filenames:

- `next` dependency means `nextjs`.
- `vite` plus React dependencies or a React plugin means `vite-react`.
- `vite` without React means `vite-vanilla`.
- `react-scripts` means `cra`.
- No package manifest plus an HTML entry means `html`.

The classifier also records the project root, package manager, lockfile, development command, build command, and detected framework version.

### 2. Preview Builder

The builder runs only in the trusted CI sync environment. Each project is unpacked into an isolated temporary directory with no gallery secrets in its environment.

Build behavior:

- HTML: no build.
- Vite: install dependencies, then run the locally installed Vite binary with `vite build` even when the package omits a build script.
- Create React App: install dependencies, then run its declared build command.
- Next.js: install dependencies and attempt a static export with a generated preview-only configuration overlay. The source archive is never modified or republished.

Install behavior follows the available lockfile:

- npm lockfile: `npm ci`.
- pnpm lockfile: pinned Corepack/pnpm install with a frozen lockfile.
- No lockfile: `npm install` with lifecycle scripts disabled by default.

If a dependency requires a lifecycle script and the build fails, the project is marked for WebContainer rather than rerunning untrusted scripts with broader CI privileges.

### 3. Static Artifact Store

Successful output is uploaded as individual R2 objects, not another monolithic ZIP. The object prefix is content-addressed:

`previews/<source-hash>/<relative-output-path>`

The source hash includes:

- ZIP content hash
- runtime profile
- builder version
- preview configuration version

This ensures unchanged templates reuse artifacts, while builder changes invalidate only affected output.

HTML already stored in the source ZIP remains on the current path initially. A later migration may extract HTML projects into the same object layout if bandwidth measurements justify it.

### 4. Preview Manifest

Each project gains a `preview` record in `data/index.json`:

```json
{
  "mode": "static",
  "runtime": "vite-vanilla",
  "sourceHash": "sha256:...",
  "artifactBase": "previews/<hash>/",
  "entry": "index.html",
  "status": "ready",
  "builderVersion": 1,
  "failureCode": null
}
```

Allowed modes are `html`, `static`, `webcontainer`, `vercel`, and `unavailable`. Allowed statuses are `ready`, `build-failed`, `runtime-required`, and `unsupported`.

Failure details stored in the public index are normalized codes and short messages. Full build logs remain CI artifacts and must not be copied into the public index.

### 5. Static Preview Loader

The gallery opens a static artifact entry in the existing sandboxed iframe. Requests resolve through the same-origin asset proxy so local and production use the same URL contract.

The API proxy maps a preview path to the fixed R2 origin and preserves Range requests, content types, and immutable cache headers. The iframe remains sandboxed and receives only the permissions required by the template.

Static files are loaded lazily by the browser. Opening a preview no longer requires downloading source files, unused images, videos, or the package lockfile.

### 6. WebContainer Runtime

The client boots at most one WebContainer per browser tab and keeps it alive while the gallery session is active. Opening a new runtime project stops the previous development process, clears the workspace, mounts the new archive, and reuses the package-manager cache.

The runtime adapter:

1. Mounts both text and binary files from the ZIP.
2. Selects npm or pnpm from the manifest.
3. Installs dependencies with progress reporting.
4. Executes the detected development command with a host accepted by the runtime.
5. Waits for the server-ready event and loads its isolated URL into the preview iframe.
6. Captures bounded stdout/stderr for the error panel.

The preview route is configured with the COOP/COEP headers required by WebContainers. The runtime UI explains that desktop Chromium provides the most reliable experience and offers the static or Vercel fallback when the browser lacks required features.

### 7. Vercel Fallback

Vercel deployment is not automatic. It appears as `Build server preview` only after WebContainer reports an unsupported runtime or package.

The server endpoint:

- Accepts only an existing indexed project ID.
- Resolves the ZIP from the fixed R2 origin; it never accepts an arbitrary upload or repository URL.
- Computes the source hash and returns an existing successful deployment when available.
- Checks a daily deployment counter before creating work.
- Creates the deployment without injecting gallery secrets into the template environment.
- Stores deployment status and URL in an R2 JSON record at `preview-deployments/<source-hash>.json`.

The gallery stops offering new deployments before the configured free-tier ceiling, leaving a safety margin for normal gallery deployments. A quota response never breaks HTML, static, or WebContainer previews.

## Data Flow

### Sync and build

1. Daily sync discovers a new archive.
2. The classifier reads its manifest and central directory.
3. The sync calculates the source hash.
4. Existing artifacts with the same hash are reused.
5. The isolated builder attempts the appropriate static build.
6. Successful output is uploaded file-by-file to R2.
7. The project preview manifest is merged into `data/index.json`.
8. The updated index is committed and deployed by the existing workflow.

### User preview

1. The modal reads the project's preview mode.
2. `html` uses the current source preview.
3. `static` loads the artifact entry immediately.
4. `webcontainer` starts or reuses the browser runtime.
5. A runtime compatibility failure exposes the optional Vercel action.
6. A cached Vercel deployment opens immediately; a new deployment shows queued, building, ready, or failed state.

## Performance and Resource Controls

- Never install dependencies during a normal static preview request.
- Cache artifacts by source and builder hash.
- Upload extracted build output so HTTP caching and lazy asset loading work per file.
- Reuse one WebContainer and its npm cache per tab.
- Limit runtime logs, install duration, mounted archive size, and concurrent work to one project per tab.
- Limit CI build concurrency to avoid package-registry and R2 rate limits.
- Retry HTTP 429 responses with exponential backoff and jitter; do not immediately fan out more requests.
- Keep Vercel fallback manual, deduplicated, and below the configured daily allowance.

## Security

- Treat every template as untrusted code.
- Do not expose R2 write credentials, Vercel tokens, Discord credentials, or gallery environment variables to a template build.
- Build each project in a disposable working directory with the minimum filesystem scope.
- Disable package lifecycle scripts on the automatic CI path.
- Serve preview code from a sandboxed iframe or isolated runtime origin.
- Restrict the Vercel endpoint to project IDs already present in the gallery index.
- Apply archive limits for entry count, expanded byte size, path traversal, symbolic links, and build time.
- Sanitize public error messages and retain detailed logs only as private CI artifacts.

## Error Handling

Every failure maps to a stable code:

- `archive-invalid`
- `archive-too-large`
- `install-failed`
- `build-failed`
- `static-export-unsupported`
- `browser-unsupported`
- `runtime-timeout`
- `runtime-package-unsupported`
- `quota-reached`
- `deployment-failed`

The UI shows the current phase and a useful recovery action. A failed static build automatically selects WebContainer. A failed WebContainer offers Vercel when quota is available. A failed Vercel deployment retains Code, Media, and Download access.

## Testing Strategy

### Unit tests

- Runtime classification for representative HTML, Vite vanilla, Vite React, CRA, and Next manifests.
- Project-root normalization and path traversal rejection.
- Source hash stability and builder-version invalidation.
- Preview manifest serialization and fallback selection.
- Free-tier quota guard and deployment deduplication.

### Integration tests

- Build fixture projects for Vite vanilla, Vite React, CRA, static-compatible Next, and dynamic Next.
- Upload artifacts to a temporary object prefix and serve them through the asset route.
- Verify CSS, JavaScript, fonts, images, nested routes, and root-relative assets.
- Verify a dynamic Next fixture is marked for WebContainer without failing the full sync.
- Verify WebContainer progress, server-ready handling, process cleanup, and cache reuse.

### Browser tests

- Preview one template from each runtime profile locally and in production-equivalent headers.
- Test Chrome/Edge as the primary runtime target and verify fallback messaging in Firefox/Safari.
- Confirm template code cannot read gallery cookies, local storage, or DOM.
- Confirm switching projects stops the previous development process.

## Rollout

The work is split into independently releasable projects:

1. **Classification and static artifact pipeline**: correct runtime metadata, build Vite/CRA, serve extracted artifacts, and migrate existing projects incrementally.
2. **Next static-export attempt**: add isolated preview configuration, record compatibility, and publish successful output.
3. **WebContainer fallback**: add the singleton browser runtime and runtime status UI.
4. **Vercel fallback**: add manual deployment, hash-based reuse, status persistence, and quota controls.

Existing HTML preview remains functional throughout the rollout. Each phase can be disabled independently with a feature flag if production verification reveals a regression.

## Success Criteria

- Existing HTML previews continue to render styles, scripts, fonts, and root-relative assets.
- Every Vite and CRA fixture produces a reusable static artifact during sync.
- Static previews do not download the source ZIP.
- Static artifact URLs work unchanged locally and in production.
- Next.js projects that fail static export automatically select WebContainer.
- A single tab never boots more than one WebContainer.
- Vercel builds are deduplicated by source hash and stop before the configured free-tier ceiling.
- Preview failures never block Code, Media, or ZIP download access.

## Out of Scope

- Collaborative editing or a full online IDE.
- Persisting changes made inside WebContainer.
- Supporting arbitrary user-uploaded projects.
- Guaranteeing native Node addon compatibility.
- Automatically rewriting template application code to force static compatibility.
- Commercial use beyond the terms of the selected free-tier services.
