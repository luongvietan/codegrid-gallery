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

## Final review fix — bounded runtime phase deadlines

### RED

Added deterministic lifecycle tests with injected 10 ms limits and a separate
100 ms test safety guard. The new cases hold each relevant operation unresolved:

- WebContainer boot;
- install output and process exit;
- dev process spawn;
- `server-ready` after a successful dev spawn.

```text
node --test lib/webcontainer-preview.test.mjs
# exit 1 — 6 passed, 4 failed
```

All four failures reported `settledBeforeGuard` as false, proving the injected
deadlines were absent and each run continued until external cancellation.

### GREEN and lifecycle design

Added configurable `RuntimePreviewTimeouts` with browser defaults of 30 seconds
for boot/mount, 120 seconds for install/spawn/output/exit, 60 seconds for dev
spawn, and 60 seconds for server readiness. Every deadline clears its timer on
settlement and aborts an internal lifecycle signal only when it actually fires.
The external component signal remains the authority for stale React updates, so
a timeout can still publish a normalized failure snapshot and expose the existing
retry action.

Late async results are handled explicitly: a WebContainer whose boot resolves
after timeout tears itself down before releasing the singleton slot, and a
process whose spawn resolves after timeout kills itself instead of entering the
already-cleaned run. Normal finally cleanup still unsubscribes listeners, kills
tracked processes, cancels readers, tears down the active container, and releases
the lease.

```text
node --test lib/webcontainer-preview.test.mjs
# exit 0 — 10 passed, 0 failed
```

Final shared verification passed:

```text
npm run test:pipeline
# exit 0 — 108 passed, 0 failed

npx eslint lib/webcontainer-preview.ts lib/webcontainer-preview.test.mjs components/ProjectModal.tsx components/tabs/RuntimePreviewTab.tsx lib/webcontainer-runtime.ts
# exit 0

npx tsc --noEmit
# exit 0

npm run build
# exit 0
```

The build emitted only the previously documented multiple-lockfile/Turbopack
root warning.

## Final reviewer correction — non-concurrent boot recovery

### RED

The real `@webcontainer/api` permits only one concurrent `boot()` call, so the
previous scheduling-slot release was invalid even though its fake lifecycle test
allowed it. Reversed the regression contract and added explicit recovery-policy
coverage:

- a boot timeout must be marked `reload`, not normal retry;
- a second lifecycle attempt while the first boot is unresolved must not call
  `boot()`;
- reload maps to `Tải lại trang`, while ordinary failure maps to `Thử lại`.

```text
node --test lib/webcontainer-preview.test.mjs
# exit 1 — 8 passed, 3 failed
# second boot was called; recovery state and policy helper were absent
```

### GREEN

Boot acquisition again retains its global scheduling slot until the real boot
promise settles. A timed-out boot publishes a `reload` recovery state; the
Preview action is labeled `Tải lại trang` and calls `window.location.reload()`.
No second boot can be scheduled behind an unresolved first boot. When the stale
promise eventually settles, its aborted run tears down that container before
the queue advances. Install, dev-start, server-ready, preparation, and other
runtime failures remain `retry` and retain the existing `Thử lại` behavior.

The Strict Mode test again requires first teardown before replacement boot and
continues to assert no post-cancel state updates.

```text
node --test lib/webcontainer-preview.test.mjs
# exit 0 — 11 passed, 0 failed
```

## Browser QA regression — Service Worker preview isolation headers

Global credentialless COEP also applies to the modal page. Legacy HTML preview
documents served from Cache Storage lacked their own compatible COEP header, so
Chromium blocked the iframe with a refused-to-connect result.

Added a VM-backed test that executes the real `public/sw.js`, loads HTML and
JavaScript through its message handler, and requests cached, missing, and asset
paths through its fetch handler.

```text
node --test public/sw.test.mjs
# RED: exit 1 — cached HTML COEP was null
# GREEN: exit 0 — 1 passed, 0 failed
```

Every preview response stored in Cache Storage now carries
`Cross-Origin-Embedder-Policy: credentialless` and
`Cross-Origin-Resource-Policy: same-origin`; synthetic preview 404 responses use
the same policy. Existing content types, response bodies, cache controls, root
aliases, scripts, and other assets are preserved.

The deadline tests assert normalized retryable failures for every phase, install
retry to ready, tracked process/listener/container cleanup, late boot teardown,
and late dev-process kill without weakening the existing Strict Mode/singleton
test.

Final verification with the concurrent ZIP-hardening worktree state also passed:

```text
npm run test:pipeline
# exit 0 — 107 passed, 0 failed

npx eslint lib/webcontainer-preview.ts lib/webcontainer-preview.test.mjs components/ProjectModal.tsx components/tabs/RuntimePreviewTab.tsx lib/webcontainer-runtime.ts
# exit 0

npx tsc --noEmit
# exit 0

npm run build
# exit 0
```

The build retains only the previously documented multiple-lockfile/Turbopack
root warning.

## Residual Important fix — retry after an unresolved timed-out boot

### Root cause and RED

The boot deadline allowed the visible run to fail, but `acquireRuntime` retained
its global scheduling slot until the unresolved `WebContainer.boot()` promise
settled. Retry therefore queued behind a promise that might never resolve and
could hit its own boot deadline without invoking `boot()`.

Extended the boot-timeout regression so it starts a retry and requires that
retry to reach ready before the first boot promise resolves. Only after retry
cleanup does the test resolve the late first container and assert immediate
teardown, zero mount/spawn calls, and no stale snapshots.

```text
node --test lib/webcontainer-preview.test.mjs
# exit 1 — 9 passed, 1 failed
# bootOrder was ["first"] instead of ["first", "retry"]
```

### GREEN and ownership decision

The boot acquisition now gives its scheduling slot an idempotent release
function and attaches it to the acquisition signal while `boot()` is pending.
A boot deadline releases scheduling ownership immediately, so retry can call
`boot()` and make progress. The stale boot promise retains its own aborted signal;
if it resolves later, its container is synchronously torn down and is never
returned, mounted, spawned, or allowed to emit state. Slot release remains
idempotent across abort, late resolution, error, and normal lease teardown.

The earlier Strict Mode test's obsolete requirement that replacement boot wait
for late teardown was updated to the new contract. It still verifies no stale
updates and cleanup, while the expanded deadline test verifies that the late
container has no active lifecycle effects.

```text
node --test lib/webcontainer-preview.test.mjs
# exit 0 — 10 passed, 0 failed
```

### Final correction verification

The later non-concurrent correction supersedes the scheduling decision in this
residual section. Final verification for the reload-required boot policy and
Service Worker isolation fix passed:

```text
npm run test:pipeline
# exit 0 — 110 passed, 0 failed

node --check public/sw.js
# exit 0

npx eslint lib/webcontainer-preview.ts lib/webcontainer-preview.test.mjs components/ProjectModal.tsx components/tabs/RuntimePreviewTab.tsx lib/webcontainer-runtime.ts public/sw.test.mjs
# exit 0

npx tsc --noEmit
# exit 0

npm run build
# exit 0
```

The production build retains only the previously documented multiple-lockfile
Turbopack-root warning.
