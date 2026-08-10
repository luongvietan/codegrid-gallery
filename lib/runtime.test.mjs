import assert from 'node:assert/strict';
import test from 'node:test';

const { runtimeBucket, runtimeLabel, runtimeBucketCounts } = await import('./runtime.ts');

test('buckets a project by what it actually runs on, not by its legacy type', () => {
  const cases = [
    [{ type: 'html', runtime: 'html' }, 'html'],
    [{ type: 'react', runtime: 'vite-vanilla' }, 'vite'],
    [{ type: 'react', runtime: 'vite-react' }, 'react'],
    [{ type: 'react', runtime: 'cra' }, 'react'],
    [{ type: 'nextjs', runtime: 'nextjs' }, 'nextjs'],
    [{ type: 'react', runtime: 'unsupported' }, 'other'],
  ];

  for (const [project, expected] of cases) {
    assert.equal(runtimeBucket(project), expected, JSON.stringify(project));
  }
});

test('never claims React for an entry whose runtime is still unknown', () => {
  assert.equal(runtimeBucket({ type: 'react' }), 'other');
  assert.equal(runtimeLabel({ type: 'react' }), 'Khác');
  assert.equal(runtimeBucket({ type: 'html' }), 'html');
  assert.equal(runtimeBucket({ type: 'nextjs' }), 'nextjs');
});

test('labels a plain Vite project as Vite rather than React', () => {
  assert.equal(runtimeLabel({ type: 'react', runtime: 'vite-vanilla' }), 'Vite');
  assert.equal(runtimeLabel({ type: 'react', runtime: 'vite-react' }), 'React');
});

test('counts every bucket, including the empty ones', () => {
  assert.deepEqual(
    runtimeBucketCounts([
      { type: 'html', runtime: 'html' },
      { type: 'react', runtime: 'vite-vanilla' },
      { type: 'react', runtime: 'vite-vanilla' },
      { type: 'nextjs', runtime: 'nextjs' },
    ]),
    { html: 1, vite: 2, react: 0, nextjs: 1, other: 0 },
  );
});
