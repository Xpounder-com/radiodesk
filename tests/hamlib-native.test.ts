import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('installed Hamlib Dummy backend integration', { skip: !process.env.RADIODESK_HAMLIB_TEST_BINARY }, () => {
  const run = spawnSync('python3', ['-B', 'bridge/test_hamlib_native.py'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
});
