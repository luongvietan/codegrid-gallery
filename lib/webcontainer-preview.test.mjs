import assert from 'node:assert/strict';
import test from 'node:test';

const {
  createRuntimeLogBuffer,
  normalizeRuntimeError,
  runtimeRecoveryPolicy,
  runRuntimePreview,
} = await import('./webcontainer-preview.ts');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function output(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function processResult({ chunks = [], exit = Promise.resolve(0), onKill = () => {} } = {}) {
  return {
    exit,
    input: new WritableStream(),
    output: output(...chunks),
    kill: onKill,
    resize() {},
  };
}

function runtimeProject() {
  return {
    files: { 'package.json': { file: { contents: '{"scripts":{"dev":"next dev"}}' } } },
    workingDirectory: 'examples/site',
    installCommand: ['npm', 'ci', '--ignore-scripts'],
    devCommand: ['npm', 'run', 'dev'],
  };
}

function fakeZip() {
  return { names: [], files: new Map() };
}

const FAST_TIMEOUTS = {
  bootMs: 10,
  installMs: 10,
  startMs: 10,
  serverReadyMs: 10,
};

async function settleBeforeGuard(run, abort) {
  let guardExpired = false;
  const guard = setTimeout(() => {
    guardExpired = true;
    abort.abort();
  }, 100);
  await run;
  clearTimeout(guard);
  return !guardExpired;
}

test('keeps only bounded recent process output while preserving split lines', () => {
  const logs = createRuntimeLogBuffer({ maxLines: 3, maxLineLength: 8 });

  logs.push('\u001b[31mfirst');
  logs.push(' line\u001b[0m\nsecond\nthird\nfourth-is-long');

  assert.deepEqual(logs.snapshot(), ['second', 'third', '-is-long']);
});

test('maps boot recovery to page reload while ordinary failures remain retryable', () => {
  assert.deepEqual(runtimeRecoveryPolicy('reload'), {
    action: 'reload',
    label: 'Tải lại trang',
  });
  assert.deepEqual(runtimeRecoveryPolicy('retry'), {
    action: 'retry',
    label: 'Thử lại',
  });
  assert.equal(runtimeRecoveryPolicy(null), null);
});

test('boots credentialless, mounts once, runs commands in one working directory, and listens before dev spawn', async () => {
  const abort = new AbortController();
  const updates = [];
  const events = [];
  const listeners = new Map();
  const kills = [];
  let teardownCount = 0;
  const container = {
    async mount(files) { events.push(['mount', files]); },
    on(event, listener) {
      events.push(['listen', event]);
      listeners.set(event, listener);
      return () => { events.push(['unsubscribe', event]); listeners.delete(event); };
    },
    async spawn(command, args, options) {
      events.push(['spawn', command, args, options]);
      if (command === 'npm' && args[0] === 'ci') {
        return processResult({ chunks: ['installed\n'], onKill: () => kills.push('install') });
      }
      assert.equal(typeof listeners.get('server-ready'), 'function');
      queueMicrotask(() => listeners.get('server-ready')?.(3000, 'https://preview.local'));
      return processResult({
        chunks: ['started\n'],
        exit: new Promise(() => {}),
        onKill: () => kills.push('dev'),
      });
    },
    teardown() { teardownCount += 1; events.push(['teardown']); },
  };

  await runRuntimePreview({
    zip: fakeZip(),
    signal: abort.signal,
    prepare: runtimeProject,
    boot: async (options) => {
      events.push(['boot', options]);
      return container;
    },
    onUpdate(snapshot) {
      updates.push(snapshot);
      if (snapshot.phase === 'ready') abort.abort();
    },
  });

  assert.deepEqual(updates.map(({ phase }) => phase), [
    'preparing', 'booting', 'installing', 'installing', 'starting', 'starting', 'ready',
  ]);
  assert.deepEqual(events[0], ['boot', { coep: 'credentialless' }]);
  assert.deepEqual(events.find(([event]) => event === 'mount'), ['mount', runtimeProject().files]);
  assert.deepEqual(events.filter(([event]) => event === 'spawn'), [
    ['spawn', 'npm', ['ci', '--ignore-scripts'], { cwd: 'examples/site' }],
    ['spawn', 'npm', ['run', 'dev'], { cwd: 'examples/site' }],
  ]);
  assert.ok(events.findIndex((event) => event[0] === 'listen' && event[1] === 'server-ready')
    < events.findIndex((event) => event[0] === 'spawn' && event[2][0] === 'run'));
  assert.equal(updates.at(-1).url, 'https://preview.local');
  assert.deepEqual(updates.at(-1).logs, ['installed', 'started']);
  assert.deepEqual(kills.sort(), ['dev', 'install']);
  assert.equal(teardownCount, 1);
  assert.equal(listeners.size, 0);
});

test('normalizes an install failure, tears down, and permits a retry', async () => {
  const updates = [];
  let attempts = 0;
  let teardownCount = 0;

  const boot = async () => ({
    async mount() {},
    on() { return () => {}; },
    async spawn() {
      attempts += 1;
      return processResult({ chunks: [`attempt ${attempts}\n`], exit: Promise.resolve(attempts === 1 ? 17 : 0) });
    },
    teardown() { teardownCount += 1; },
  });

  await runRuntimePreview({
    zip: fakeZip(),
    signal: new AbortController().signal,
    prepare: runtimeProject,
    boot,
    onUpdate: (snapshot) => updates.push(snapshot),
  });

  assert.equal(updates.at(-1).phase, 'failure');
  assert.equal(updates.at(-1).error, 'npm ci exited with code 17.');
  assert.deepEqual(updates.at(-1).logs, ['attempt 1']);
  assert.equal(teardownCount, 1);

  const retryAbort = new AbortController();
  await runRuntimePreview({
    zip: fakeZip(),
    signal: retryAbort.signal,
    prepare: runtimeProject,
    boot: async () => ({
      async mount() {},
      on(event, listener) {
        if (event === 'server-ready') queueMicrotask(() => listener(3000, 'https://retry.local'));
        return () => {};
      },
      async spawn(command) {
        if (command === 'npm' && attempts++ > 1) {
          return processResult({ exit: new Promise(() => {}) });
        }
        return processResult();
      },
      teardown() { teardownCount += 1; },
    }),
    onUpdate(snapshot) {
      if (snapshot.phase === 'ready') retryAbort.abort();
    },
  });

  assert.equal(teardownCount, 2);
});

test('fails and cleans up when install output rejects before exit, then permits retry', async () => {
  const firstAbort = new AbortController();
  const updates = [];
  let killCount = 0;
  let teardownCount = 0;
  const firstRun = runRuntimePreview({
    zip: fakeZip(),
    signal: firstAbort.signal,
    prepare: runtimeProject,
    boot: async () => ({
      async mount() {},
      on() { return () => {}; },
      async spawn() {
        return {
          ...processResult({
            exit: new Promise(() => {}),
            onKill: () => { killCount += 1; },
          }),
          output: new ReadableStream({
            pull() { throw new Error('install output unavailable'); },
          }),
        };
      },
      teardown() { teardownCount += 1; },
    }),
    onUpdate: (snapshot) => updates.push(snapshot),
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    firstAbort.abort();
  }, 100);
  await firstRun;
  clearTimeout(timeout);

  assert.equal(timedOut, false, 'install stream rejection must settle before process exit');
  assert.equal(updates.at(-1).phase, 'failure');
  assert.equal(updates.at(-1).error, 'install output unavailable');
  assert.equal(killCount, 1);
  assert.equal(teardownCount, 1);

  const retryAbort = new AbortController();
  let retryReady = false;
  await runRuntimePreview({
    zip: fakeZip(),
    signal: retryAbort.signal,
    prepare: runtimeProject,
    boot: async () => ({
      async mount() {},
      on(event, listener) {
        if (event === 'server-ready') queueMicrotask(() => listener(3000, 'https://retry.local'));
        return () => {};
      },
      async spawn(_command, args) {
        return processResult({ exit: args[0] === 'ci' ? Promise.resolve(0) : new Promise(() => {}) });
      },
      teardown() { teardownCount += 1; },
    }),
    onUpdate(snapshot) {
      if (snapshot.phase === 'ready') {
        retryReady = true;
        retryAbort.abort();
      }
    },
  });

  assert.equal(retryReady, true);
  assert.equal(teardownCount, 2);
});

test('boot timeout requires reload and never starts a second boot while the first is unresolved', async () => {
  const abort = new AbortController();
  const boot = deferred();
  const updates = [];
  const bootOrder = [];
  let lateMountCount = 0;
  let lateSpawnCount = 0;
  let lateTeardownCount = 0;
  const run = runRuntimePreview({
    zip: fakeZip(),
    signal: abort.signal,
    prepare: runtimeProject,
    timeouts: FAST_TIMEOUTS,
    boot: () => {
      bootOrder.push('first');
      return boot.promise;
    },
    onUpdate: (snapshot) => updates.push(snapshot),
  });

  const settledBeforeGuard = await settleBeforeGuard(run, abort);
  const updatesAfterTimeout = updates.length;
  const secondAbort = new AbortController();
  const secondUpdates = [];
  let secondReady = false;
  const secondRun = runRuntimePreview({
    zip: fakeZip(),
    signal: secondAbort.signal,
    prepare: runtimeProject,
    timeouts: FAST_TIMEOUTS,
    boot: async () => {
      bootOrder.push('second');
      return {
        async mount() {},
        on(event, listener) {
          if (event === 'server-ready') queueMicrotask(() => listener(3000, 'https://retry.local'));
          return () => {};
        },
        async spawn(_command, args) {
          return processResult({ exit: args[0] === 'ci' ? Promise.resolve(0) : new Promise(() => {}) });
        },
        teardown() {},
      };
    },
    onUpdate(snapshot) {
      secondUpdates.push(snapshot);
      if (snapshot.phase === 'ready') {
        secondReady = true;
        secondAbort.abort();
      }
    },
  });
  const secondSettledBeforeGuard = await settleBeforeGuard(secondRun, secondAbort);

  boot.resolve({
    async mount() { lateMountCount += 1; },
    on() { return () => {}; },
    async spawn() { lateSpawnCount += 1; return processResult(); },
    teardown() { lateTeardownCount += 1; },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settledBeforeGuard, true);
  assert.equal(secondSettledBeforeGuard, true);
  assert.deepEqual(bootOrder, ['first']);
  assert.equal(secondReady, false);
  assert.equal(updates.at(-1).phase, 'failure');
  assert.equal(updates.at(-1).error, 'Runtime boot timed out.');
  assert.equal(updates.at(-1).recovery, 'reload');
  assert.equal(secondUpdates.at(-1).phase, 'failure');
  assert.equal(secondUpdates.at(-1).recovery, 'reload');
  assert.equal(updates.length, updatesAfterTimeout);
  assert.equal(lateMountCount, 0);
  assert.equal(lateSpawnCount, 0);
  assert.equal(lateTeardownCount, 1);
});

test('times out install output and exit, cleans up, and permits retry', async () => {
  const abort = new AbortController();
  const updates = [];
  let killCount = 0;
  let teardownCount = 0;
  const run = runRuntimePreview({
    zip: fakeZip(),
    signal: abort.signal,
    prepare: runtimeProject,
    timeouts: FAST_TIMEOUTS,
    boot: async () => ({
      async mount() {},
      on() { return () => {}; },
      async spawn() {
        return {
          ...processResult({
            exit: new Promise(() => {}),
            onKill: () => { killCount += 1; },
          }),
          output: new ReadableStream({ start() {} }),
        };
      },
      teardown() { teardownCount += 1; },
    }),
    onUpdate: (snapshot) => updates.push(snapshot),
  });

  assert.equal(await settleBeforeGuard(run, abort), true);
  assert.equal(updates.at(-1).phase, 'failure');
  assert.equal(updates.at(-1).error, 'Dependency install timed out.');
  assert.equal(updates.at(-1).recovery, 'retry');
  assert.equal(killCount, 1);
  assert.equal(teardownCount, 1);

  const retryAbort = new AbortController();
  let retryReady = false;
  await runRuntimePreview({
    zip: fakeZip(),
    signal: retryAbort.signal,
    prepare: runtimeProject,
    timeouts: FAST_TIMEOUTS,
    boot: async () => ({
      async mount() {},
      on(event, listener) {
        if (event === 'server-ready') queueMicrotask(() => listener(3000, 'https://retry.local'));
        return () => {};
      },
      async spawn(_command, args) {
        return processResult({ exit: args[0] === 'ci' ? Promise.resolve(0) : new Promise(() => {}) });
      },
      teardown() { teardownCount += 1; },
    }),
    onUpdate(snapshot) {
      if (snapshot.phase === 'ready') {
        retryReady = true;
        retryAbort.abort();
      }
    },
  });
  assert.equal(retryReady, true);
  assert.equal(teardownCount, 2);
});

test('times out a stalled dev spawn and kills the process if it resolves late', async () => {
  const abort = new AbortController();
  const devSpawn = deferred();
  const updates = [];
  let spawnCount = 0;
  let lateKillCount = 0;
  let teardownCount = 0;
  const run = runRuntimePreview({
    zip: fakeZip(),
    signal: abort.signal,
    prepare: runtimeProject,
    timeouts: FAST_TIMEOUTS,
    boot: async () => ({
      async mount() {},
      on() { return () => {}; },
      async spawn() {
        spawnCount += 1;
        return spawnCount === 1 ? processResult() : devSpawn.promise;
      },
      teardown() { teardownCount += 1; },
    }),
    onUpdate: (snapshot) => updates.push(snapshot),
  });

  const settledBeforeGuard = await settleBeforeGuard(run, abort);
  devSpawn.resolve(processResult({
    exit: new Promise(() => {}),
    onKill: () => { lateKillCount += 1; },
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settledBeforeGuard, true);
  assert.equal(updates.at(-1).phase, 'failure');
  assert.equal(updates.at(-1).error, 'Dev server start timed out.');
  assert.equal(teardownCount, 1);
  assert.equal(lateKillCount, 1);
});

test('times out server readiness and cleans up the running dev process', async () => {
  const abort = new AbortController();
  const updates = [];
  let spawnCount = 0;
  let killCount = 0;
  let unsubscribeCount = 0;
  let teardownCount = 0;
  const run = runRuntimePreview({
    zip: fakeZip(),
    signal: abort.signal,
    prepare: runtimeProject,
    timeouts: FAST_TIMEOUTS,
    boot: async () => ({
      async mount() {},
      on() { return () => { unsubscribeCount += 1; }; },
      async spawn() {
        spawnCount += 1;
        return processResult({
          exit: spawnCount === 1 ? Promise.resolve(0) : new Promise(() => {}),
          onKill: () => { killCount += 1; },
        });
      },
      teardown() { teardownCount += 1; },
    }),
    onUpdate: (snapshot) => updates.push(snapshot),
  });

  assert.equal(await settleBeforeGuard(run, abort), true);
  assert.equal(updates.at(-1).phase, 'failure');
  assert.equal(updates.at(-1).error, 'Server readiness timed out.');
  assert.equal(killCount, 2);
  assert.equal(unsubscribeCount, 2);
  assert.equal(teardownCount, 1);
});

test('cancels a stale boot without post-cancel updates before the replacement starts', async () => {
  const firstBoot = deferred();
  const firstBootStarted = deferred();
  const firstAbort = new AbortController();
  const firstUpdates = [];
  const lifecycle = [];

  function container(name, readyUrl) {
    return {
      async mount() {},
      on(event, listener) {
        if (event === 'server-ready' && readyUrl) queueMicrotask(() => listener(3000, readyUrl));
        return () => {};
      },
      async spawn(command) {
        return processResult({ exit: command === 'npm' && readyUrl ? Promise.resolve(0) : new Promise(() => {}) });
      },
      teardown() {
        lifecycle.push(`teardown:${name}`);
      },
    };
  }

  const firstRun = runRuntimePreview({
    zip: fakeZip(),
    signal: firstAbort.signal,
    prepare: runtimeProject,
    boot: async () => {
      lifecycle.push('boot:first');
      firstBootStarted.resolve();
      return firstBoot.promise;
    },
    onUpdate: (snapshot) => firstUpdates.push(snapshot),
  });
  await firstBootStarted.promise;
  firstAbort.abort();
  const updatesAtCancel = firstUpdates.length;

  const secondAbort = new AbortController();
  const secondRun = runRuntimePreview({
    zip: fakeZip(),
    signal: secondAbort.signal,
    prepare: runtimeProject,
    boot: async () => {
      lifecycle.push('boot:second');
      return container('second', 'https://second.local');
    },
    onUpdate(snapshot) {
      if (snapshot.phase === 'ready') secondAbort.abort();
    },
  });

  await Promise.resolve();
  assert.deepEqual(lifecycle, ['boot:first']);
  firstBoot.resolve(container('first'));
  await Promise.all([firstRun, secondRun]);

  assert.equal(firstUpdates.length, updatesAtCancel);
  assert.deepEqual(lifecycle, [
    'boot:first', 'teardown:first', 'boot:second', 'teardown:second',
  ]);
});

test('normalizes unknown failures without leaking object formatting', () => {
  assert.equal(normalizeRuntimeError(new Error('broken')), 'broken');
  assert.equal(normalizeRuntimeError({ message: 'runtime unavailable' }), 'runtime unavailable');
  assert.equal(normalizeRuntimeError({ token: 'do-not-render' }), 'Runtime preview failed.');
});
