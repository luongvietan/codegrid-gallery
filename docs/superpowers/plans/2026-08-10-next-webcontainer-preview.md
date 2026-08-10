# Next.js WebContainer Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Next.js `runtime-required` placeholder with a real in-browser preview that works locally and in production without server-side compute.

**Architecture:** Keep static and HTML previews unchanged. For `runtime-required` projects, lazily download the existing source ZIP, validate and convert it into a WebContainer file tree, install dependencies, run the archive's development command, and point the existing sandboxed iframe at the `server-ready` URL. Tear the runtime down when the modal closes.

**Tech Stack:** Next.js 16, React 19, TypeScript, `@webcontainer/api`, Node test runner.

## Global Constraints

- Personal, non-commercial project; no paid server runtime or WebContainer commercial API key.
- Keep the main development server on port 3010 live throughout implementation.
- WebContainer starts only when a runtime preview is opened and must stop when the modal closes.
- Static artifact and legacy HTML preview behavior remains unchanged.
- All source paths are validated before mounting; `.git`, `.next`, and `node_modules` remain excluded by ZIP extraction.
- Production pages must emit COOP/COEP headers required by WebContainers.

---

### Task 1: Runtime source preparation

**Files:**
- Create: `lib/webcontainer-runtime.ts`
- Create: `lib/webcontainer-runtime.test.mjs`
- Modify: `lib/preview.ts`
- Modify: `lib/preview.test.mjs`

**Interfaces:**
- Produces `prepareRuntimeProject(zip)` with a validated file tree, working directory, install command, and dev command.
- Changes `needsSourceZip('preview', 'runtime-required')` to `true`.

- [ ] Write tests that reject unsafe paths, select the shallowest package root, preserve binary files, derive npm/pnpm commands, and require ZIP for runtime Preview.
- [ ] Run focused tests and verify they fail because the runtime preparation API and policy are missing.
- [ ] Implement the minimal pure preparation functions.
- [ ] Run focused tests and verify they pass.

### Task 2: WebContainer preview lifecycle

**Files:**
- Modify: `components/tabs/RuntimePreviewTab.tsx`
- Modify: `components/ProjectModal.tsx`
- Modify: `next.config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- `RuntimePreviewTab` consumes the extracted ZIP and owns boot/install/dev/teardown.
- `ProjectModal` lazily loads ZIP for runtime previews and renders progress, errors, iframe refresh, and new-tab controls.

- [ ] Install `@webcontainer/api@1.6.4`.
- [ ] Add credentialless COEP and same-origin COOP response headers.
- [ ] Replace the placeholder with a runtime component that boots once, mounts files, installs dependencies, starts the dev command, streams bounded status output, waits for `server-ready`, and tears down on unmount.
- [ ] Preserve the current iframe sandbox and toolbar actions.
- [ ] Run focused lint, TypeScript, pipeline tests, and production build.

### Task 3: Browser verification and integration

**Files:**
- No production files unless QA exposes a regression.

- [ ] Run the worktree dev server on port 3011 and verify cross-origin isolation.
- [ ] Open a Next.js project and verify ZIP loading, progress, runtime server readiness, and rendered iframe.
- [ ] Close the modal and verify cleanup; re-open another stack and verify HTML/React previews still work.
- [ ] Request independent code review and fix Critical/Important findings.
- [ ] Commit, merge into `master`, run the full suite/build on the merged result, push, and remove the temporary worktree.
