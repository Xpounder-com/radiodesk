import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureSampleClock } from '../src/audio/sample-clock.ts';
import { CAPTURE_WORKLET_SOURCE } from '../src/audio/worklet.ts';
import vm from 'node:vm';

test('worklet sample positions preserve UTC timing through delayed main-thread dispatch', () => {
  const clock = new CaptureSampleClock(48000);
  const first = clock.observe(512, 512, 100000 + 512 / 48, 512 / 48, 512 / 48000);
  const delayed = clock.observe(1024, 512, 100085, 85, 0.085);
  assert.ok(Math.abs(first.endUtcMs - 100000 - 512 / 48) < 1e-8);
  assert.ok(Math.abs(delayed.endUtcMs - 100000 - 1024 / 48) < 1e-8);
  assert.equal(delayed.discontinuities, 0);
});

test('sample-position gaps and UTC clock steps increment explicit discontinuity identity', () => {
  const clock = new CaptureSampleClock(48000);
  clock.observe(512, 512, 100010, 10, 0.01);
  const dropped = clock.observe(1536, 512, 100032, 32, 0.032);
  assert.equal(dropped.discontinuities, 1);
  const jumped = clock.observe(2048, 512, 101043, 43, 0.043);
  assert.equal(jumped.discontinuities, 2);
  assert.ok(jumped.endUtcMs > 101000);
});

test('suspended audio context does not hide an elapsed wall-clock capture gap', () => {
  const clock = new CaptureSampleClock(48000);
  clock.observe(512, 512, 100010, 10, 0.01);
  const resumed = clock.observe(1024, 512, 101020, 1020, 0.02);
  assert.equal(resumed.discontinuities, 1);
});

test('capture worklet discards a partial block at an input gap instead of mixing pre-gap samples', () => {
  const messages: { buffer: ArrayBuffer; endFrame: number; discontinuities: number }[] = [];
  let Processor: any;
  class BaseProcessor { port = { postMessage: (message: any) => messages.push(message) }; }
  const context = vm.createContext({ Float32Array, currentFrame: 0, AudioWorkletProcessor: BaseProcessor, registerProcessor: (_name: string, type: any) => { Processor = type; } });
  vm.runInContext(CAPTURE_WORKLET_SOURCE, context);
  const capture = new Processor();
  capture.process([[new Float32Array(128).fill(1)]], []);
  context.currentFrame = 128; capture.process([[]], []);
  for (const position of [256, 384, 512, 640]) { context.currentFrame = position; capture.process([[new Float32Array(128).fill(2)]], []); }
  assert.equal(messages.length, 1); assert.equal(messages[0].endFrame, 768); assert.equal(messages[0].discontinuities, 1);
  assert.ok(new Float32Array(messages[0].buffer).every(sample => sample === 2));
  const clock = new CaptureSampleClock(48000);
  assert.equal(clock.observe(768, 512, 100016, 16, 0.016, 1).discontinuities, 1);
});
