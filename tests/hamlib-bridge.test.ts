import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('Python Hamlib bridge capability, control, lease and WebSocket boundaries', () => {
  const run = spawnSync('python3', ['-B', 'bridge/test_hamlib_ws.py'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
});
