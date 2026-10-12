import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('Python standard-library IQ bridge framing and origin/control boundaries', () => {
  const run = spawnSync('python3', ['-B', 'bridge/test_rtl_tcp_ws.py'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
});
