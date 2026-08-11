import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// `npm test` names its files explicitly (a glob in the script does not expand on
// Windows). The cost is that a new test file is simply never run — assembly's 15
// tests sat unwired long enough for a syntax error in one of them to go unseen.
// This test is the thing that notices.
//
// It checks EVERY npm script, not just `test`, because not every test belongs in
// the hermetic suite: assets-proxy.test.mjs fetches a running dev server, so it
// lives in `test:integration`. Forcing it into `npm test` made the suite hang for
// three minutes against a port that was not listening.
test('every *.test.mjs file is wired into an npm script', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const listed = new Set(
    Object.values(pkg.scripts).join(' ').split(/\s+/).filter((w) => w.endsWith('.test.mjs')),
  );
  const found = [];
  for (const dir of ['scripts', 'scripts/rag', 'lib', 'public']) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.test.mjs')) found.push(path.posix.join(dir, f));
    }
  }
  const missing = found.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `not run by any npm script: ${missing.join(', ')}`);
});
