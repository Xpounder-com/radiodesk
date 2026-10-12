import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fft, analyzeSpectrum } from '../src/dsp/fft.ts';
import { BiquadFilter, biquadCoefficients, bandpassCoefficients } from '../src/dsp/filters.ts';
import { encodeWav, decodeWav } from '../src/audio/wav.ts';
import { DSP_WORKER_SOURCE } from '../src/dsp/worker.ts';
import { SignalEngine } from '../src/audio/engine.ts';

function tone(frequency: number, rate = 48000, size = 2048, amplitude = 0.5): Float32Array {
  return Float32Array.from({ length: size }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / rate));
}

test('FFT impulse has equal energy at every frequency', () => {
  const real = new Float64Array(16); real[0] = 1; const imaginary = new Float64Array(16);
  fft(real, imaginary); assert.ok([...real].every(value => value === 1)); assert.ok([...imaginary].every(value => value === 0));
  assert.throws(() => fft(new Float32Array(12), new Float32Array(12)), /power of two/);
});

test('Hann spectrum reports an isolated reference tone in dBFS and interpolates frequency', () => {
  const result = analyzeSpectrum(tone(703.125), 48000);
  assert.ok(Math.abs(result.peakHz - 703.125) < 0.1);
  assert.ok(Math.abs(result.peakDb - (-6.0206)) < 0.01);
  assert.ok(Math.abs(result.rms - Math.SQRT1_2 / 2) < 0.001);
  assert.equal(result.bins.length, 1024);
  assert.ok(result.noiseDb < -100);
  const offBin = analyzeSpectrum(tone(715), 48000); assert.ok(Math.abs(offBin.peakHz - 715) < 1);
  const silent = analyzeSpectrum(new Float32Array(2048), 48000); assert.equal(silent.peakHz, 0); assert.equal(silent.peakDb, -140);
});

test('biquad passband retains 700 Hz and attenuates 7 kHz', () => {
  const measure = (frequency: number) => {
    const filters = bandpassCoefficients(300, 1200, 48000).map(coefficients => new BiquadFilter(coefficients));
    const input = tone(frequency, 48000, 48000);
    const output = filters.reduce((samples, filter) => filter.processBlock(samples), input);
    return Math.sqrt(output.subarray(24000).reduce((sum, sample) => sum + sample * sample, 0) / 24000);
  };
  assert.ok(measure(700) > 0.25); assert.ok(measure(7000) < 0.01);
  assert.throws(() => biquadCoefficients('lowpass', 24000, 48000), /Nyquist/);
  assert.throws(() => bandpassCoefficients(2000, 1000, 48000), /low edge/);
});

test('PCM16 WAV preserves sample rate, polarity and quantised samples', () => {
  const samples = new Float32Array([-1, -0.5, 0, 0.5, 1]);
  const decoded = decodeWav(encodeWav(samples, 44100));
  assert.equal(decoded.sampleRate, 44100); assert.equal(decoded.channels, 1); assert.equal(decoded.bitsPerSample, 16);
  samples.forEach((sample, index) => assert.ok(Math.abs(decoded.samples[index] - sample) <= 1 / 32768));
  assert.throws(() => decodeWav(new ArrayBuffer(44)), /RIFF WAV/);
  assert.throws(() => decodeWav(encodeWav(samples).slice(0, 45)), /truncated/);
});

test('WAV decoder walks padded metadata chunks rather than assuming a 44-byte header', () => {
  const plain = new Uint8Array(encodeWav(new Float32Array([0.25, -0.25]), 16000));
  const extended = new Uint8Array(plain.length + 10); extended.set(plain.subarray(0, 36));
  extended.set([74, 85, 78, 75, 1, 0, 0, 0, 42, 0], 36); extended.set(plain.subarray(36), 46);
  new DataView(extended.buffer).setUint32(4, extended.length - 8, true);
  const decoded = decodeWav(extended.buffer); assert.equal(decoded.samples.length, 2); assert.equal(decoded.samples[0], 0.25);
});

test('inline worker executes real FFT with the same measurement as the reference implementation', () => {
  const messages: any[] = [];
  const context = vm.createContext({ Float32Array, Float64Array, Math, Number, Array, postMessage: (message: any) => messages.push(message) });
  vm.runInContext(DSP_WORKER_SOURCE, context);
  context.onmessage({ data: { type: 'init', sampleRate: 48000, fftSize: 2048, gain: 1 } });
  const samples = tone(703.125, 48000, 4096);
  context.onmessage({ data: { type: 'samples', buffer: samples.buffer, timestamp: 123 } });
  const result = messages.find(message => message.type === 'frame').frame;
  const expected = analyzeSpectrum(samples.slice(2048), 48000);
  assert.ok(Math.abs(result.peakHz - expected.peakHz) < 0.001); assert.equal(result.peakDb, expected.peakDb); assert.equal(result.timestamp, 123);
  assert.equal(messages.at(-1).type, 'ack');
});

test('receive engine can stop before a source exists without browser audio globals', () => {
  const engine = new SignalEngine(); engine.stop(); assert.equal(engine.source, 'Stopped');
  assert.throws(() => engine.startRecording(), /Start an audio source/);
  assert.throws(() => engine.setGain(-1), /gain/); assert.throws(() => engine.setBandpass(2000, 500), /Passband/);
  assert.equal(engine.stopRecording(), null);
});
