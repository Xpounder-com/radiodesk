import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import type { SdrFrame } from '../src/sdr/controller.ts';

test('bundled SDR worker processes a continuous IQ stream into RF frames and detector audio', async () => {
  const bundle = await build({ entryPoints: ['src/sdr/worker-entry.ts'], bundle: true, write: false, format: 'iife', target: 'es2022' });
  const messages: Record<string, unknown>[] = [];
  const scope: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (data: Record<string, unknown>) => void } = { onmessage: null, postMessage: data => messages.push(data) };
  vm.runInNewContext(bundle.outputFiles[0]!.text, { self: scope }, { timeout: 2000 });
  const send = (data: unknown) => scope.onmessage!({ data });
  send({ type: 'init', sampleRate: 192000, centerFrequency: 100000000, fftSize: 4096, source: 'Simulated IQ fixture', demodulation: { mode: 'AM', offsetHz: 20000, bandwidthHz: 10000 }, configurationRevision: 7 });
  for (let block = 0; block < 40; block++) {
    const iq = new Float32Array(9600);
    for (let i = 0; i < 4800; i++) {
      const t = (block * 4800 + i) / 192000, amplitude = 0.5 * (1 + 0.5 * Math.sin(2 * Math.PI * 1000 * t)), phase = 2 * Math.PI * 20000 * t;
      iq[i * 2] = amplitude * Math.cos(phase); iq[i * 2 + 1] = amplitude * Math.sin(phase);
    }
    send({ type: 'iq', buffer: iq.buffer, timestamp: block * 25 });
  }
  assert.equal(messages.filter(message => message.type === 'error').length, 0);
  assert.equal(messages.filter(message => message.type === 'ack').length, 40);
  const spectra = messages.filter(message => message.type === 'frame'); assert.equal(spectra.length, 20);
  for (const message of spectra) {
    const frame = message.frame as SdrFrame;
    assert.equal(message.configurationRevision, 7); assert.ok(Math.abs(frame.peakFrequency - 100020000) < 1);
    assert.equal(frame.bins.length, 4096); assert.equal(frame.source, 'Simulated IQ fixture');
  }
  const audio = messages.filter(message => message.type === 'audio');
  assert.equal(audio.length, 40); assert.equal(audio.reduce((sum, message) => sum + (message.samples as Float32Array).length, 0), 48000);
  assert.ok(audio.every(message => message.sampleRate === 48000 && message.configurationRevision === 7));
  send({ type: 'config', centerFrequency: 144000000, configurationRevision: 8 });
  messages.length = 0;
  send({ type: 'iq', buffer: new Float32Array(19200).buffer, timestamp: 1000 });
  assert.ok(messages.every(message => message.type === 'ack' || message.configurationRevision === 8));
});
