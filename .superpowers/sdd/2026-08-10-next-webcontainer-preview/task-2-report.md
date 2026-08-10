# Task 2 report — WebContainer preview lifecycle

## Scope

Implemented the Task 2 browser-runtime lifecycle in the isolated
`next-webcontainer-preview` worktree:

- replaced the runtime placeholder with a real WebContainer boot/mount/install/dev flow;
- added a pure lifecycle runner and focused tests;
- lazily reused the guarded project ZIP loader for runtime Preview and Code;
- added same-origin COOP and credentialless COEP response headers;
- kept the runtime iframe sandbox byte-for-byte equal to the existing static and legacy HTML sandbox;
- added bounded user-visible runtime output and failure retry UI.

`@webcontainer/api` was already installed and locked at `1.6.4` at the Task 2 base
commit. I did not reinstall it or change `package-lock.json` or the dependency
version.

## TDD evidence

### RED

Created `lib/webcontainer-preview.test.mjs` before the lifecycle implementation,
then ran:

```text
node --test lib/webcontainer-preview.test.mjs
```

The command exited 1 with `ERR_MODULE_NOT_FOUND` for
`lib/webcontainer-preview.ts`. This was the expected failure because the tested
lifecycle boundary did not exist yet.

The failing tests specified these behaviors before implementation:

- bounded recent output with split-line handling and ANSI removal;
- credentialless boot, one mount, exact command/cwd invocation, and
  `server-ready` subscription before the dev spawn;
- normalized non-zero install failure, complete cleanup, and a subsequent retry;
- cancellation while boot is unresolved, no post-cancel updates, teardown before
  the queued replacement boot, and a maximum of one live container;
- safe normalization of unknown thrown values.

### GREEN

Added the minimal pure runner and reran the focused suite:

```text
node --test lib/webcontainer-preview.test.mjs
# exit 0 — 5 passed, 0 failed
```

After the React integration, the combined focused command also passed:

```text
node --test lib/webcontainer-runtime.test.mjs lib/webcontainer-preview.test.mjs lib/preview.test.mjs
# exit 0 — 18 passed, 0 failed
```

Node's existing `MODULE_TYPELESS_PACKAGE_JSON` warning remains when tests import
TypeScript directly with `node --test`. The project pipeline uses `tsx` and does
not emit that warning.

## Lifecycle decisions

- `lib/webcontainer-preview.ts` owns runtime mechanics independently of React.
  The component supplies only the ZIP, a cancellation signal, a boot function,
  and a snapshot callback.
- A module-level lease queue serializes boots. A replacement run cannot call
  `WebContainer.boot()` until the preceding run has torn down, including the
  Strict Mode case where unmount happens while the first boot promise is still
  unresolved.
- Every snapshot checks the run's abort signal. `RuntimePreviewTab` adds a
  monotonically increasing run ID, so a stale callback cannot update the current
  component even around effect cleanup/retry boundaries.
- Boot always receives `{ coep: 'credentialless' }`. The app emits
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: credentialless` for `/:path*`.
- The prepared tree is mounted once. Install and dev commands are split into
  executable/arguments and both spawn with the same prepared
  `workingDirectory` as `cwd`.
- The `server-ready` and runtime-error listeners are attached before dev spawn.
  Only the active run can publish the returned URL.
- Process output covers the WebContainer stream containing stdout and stderr.
  The buffer strips ANSI control sequences, handles chunks split across lines,
  and retains at most 80 lines with at most 500 characters per line.
- Cleanup unsubscribes listeners, kills every spawned process, cancels active
  readers, tears down the WebContainer, and releases the global lease.
- Runtime failures are rendered inside Preview with retained bounded logs and a
  `Thử lại` action. Retry starts a new cancellable run without closing the modal.
- Ready previews preserve the existing sandbox exactly. Refresh safely resets
  the iframe `src`; New Tab uses `noopener,noreferrer`.
- `ProjectModal` stores tab, ZIP, loading, and error state against a project key.
  An old fetch cannot replace the current project's ZIP or toast its error, and
  Preview and Code reuse the same extracted ZIP for the active project.

## Verification

All requested Task 2 commands completed successfully:

```text
npm run test:pipeline
# exit 0 — 88 passed, 0 failed

npx eslint components/ProjectModal.tsx components/tabs/RuntimePreviewTab.tsx lib/webcontainer-runtime.ts
# exit 0

npx tsc --noEmit
# exit 0

npm run build
# exit 0 — Next.js 16.2.9 production build compiled and generated all routes
```

The new lifecycle implementation was also included in an additional lint run:

```text
npx eslint components/ProjectModal.tsx components/tabs/RuntimePreviewTab.tsx lib/webcontainer-runtime.ts lib/webcontainer-preview.ts
# exit 0
```

`npm run build` reports the existing worktree warning that Next.js found multiple
lockfiles and inferred the parent workspace as the Turbopack root. It does not
affect the successful build.

## Concerns and handoff

No Task 2 blocker remains. Real-browser cross-origin isolation, a live Next.js
ZIP boot, modal-close cleanup observation, and static/legacy preview regression
checks are intentionally left to Task 3 browser QA as required by the task
boundary.

## Round 1 review fix — install output rejection

### Root cause

The install output reader was saved for a later wait, but the lifecycle first
waited for `install.exit`. If the output stream rejected while the exit promise
remained unresolved, the reader rejection was temporarily unhandled and could
not reach the runner's normalized failure and cleanup path. The dev output path
already avoided this by forwarding reader rejection into the shared
`runtimeError` promise.

### RED

Added a focused regression case whose install output rejects with
`install output unavailable` while `install.exit` never settles. The test also
requires a failure snapshot, process/container cleanup, and a successful retry.

```text
node --test lib/webcontainer-preview.test.mjs
# exit 1 — 5 passed, 1 failed
# failing error: install output unavailable
```

The failure was the expected unhandled stream rejection; the run otherwise
remained pending until the test cancellation guard fired.

### GREEN

Attached the install reader rejection immediately and forwarded it into the same
`runtimeError` channel used by the dev reader. This makes the existing install
exit race reject immediately, after which the normal catch/finally path publishes
the normalized failure, kills the process, tears down the container, and releases
the lease for retry.

```text
node --test lib/webcontainer-preview.test.mjs
# exit 0 — 6 passed, 0 failed
```
