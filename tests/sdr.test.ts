import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeIqSpectrum, AudioResampler, decodeIq, IqDemodulator, RtlTcpParser, rtlCommand, U8IqDecoder } from '../src/sdr/index.ts';
import { analyzeSpectrum } from '../src/dsp/fft.ts';
import { encodeWav } from '../src/audio/wav.ts';

const near = (actual: number, expected: number, tolerance = 1e-6): void => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`);
function header(): Uint8Array { const bytes = new Uint8Array(12), view = new DataView(bytes.buffer); bytes.set([82, 84, 76, 48]); view.setUint32(4, 5); view.setUint32(8, 29); return bytes; }
function tone(count: number, sampleRate: number, frequency: number, amplitude = 0.5): Float32Array {
  const iq = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) { iq[2 * i] = amplitude * Math.cos(2 * Math.PI * frequency * i / sampleRate); iq[2 * i + 1] = amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate); }
  return iq;
}

test('RTL0 preamble is correct under every header split and carries IQ bytes', () => {
  const bytes = new Uint8Array(18); bytes.set(header()); bytes.set([0, 255, 128, 127, 64, 192], 12);
  for (let split = 0; split <= 18; split++) {
    const parser = new RtlTcpParser(), first = parser.push(bytes.subarray(0, split)), second = parser.push(bytes.subarray(split));
    assert.equal(parser.header?.tunerName, 'R820T'); assert.equal(parser.header?.tunerGainCount, 29);
    assert.deepEqual(new Uint8Array([...first.iq, ...second.iq]), bytes.subarray(12));
  }
  const parser = new RtlTcpParser(); const pieces: number[] = [];
  for (const byte of bytes) pieces.push(...parser.push(Uint8Array.of(byte)).iq);
  assert.deepEqual(pieces, [0, 255, 128, 127, 64, 192]);
  assert.throws(() => new RtlTcpParser().push(new Uint8Array(12)), /RTL0/);
});

test('rtl_tcp command fixtures use packed network-endian parameters', () => {
  assert.deepEqual([...rtlCommand('frequency', 100_000_000)], [1, 5, 245, 225, 0]);
  assert.deepEqual([...rtlCommand('sampleRate', 2_048_000)], [2, 0, 31, 64, 0]);
  assert.deepEqual([...rtlCommand('gainMode', 1)], [3, 0, 0, 0, 1]);
  assert.deepEqual([...rtlCommand('gain', -100)], [4, 255, 255, 255, 156]);
  assert.deepEqual([...rtlCommand('ppm', -12)], [5, 255, 255, 255, 244]);
  assert.throws(() => rtlCommand('frequency', 1.5), RangeError);
  assert.throws(() => rtlCommand('gainMode', 2), RangeError);
});

test('unsigned eight-bit IQ is symmetric and keeps I/Q alignment through odd fragments', () => {
  const input = Uint8Array.of(0, 255, 127, 128, 64, 192, 30, 40);
  const reference = new U8IqDecoder().decode(input);
  near(reference[0]!, -0.99609375); near(reference[1]!, 0.99609375);
  near(reference[2]! + reference[3]!, 0);
  for (let split = 0; split <= input.length; split++) {
    const decoder = new U8IqDecoder(), a = decoder.decode(input.subarray(0, split)), b = decoder.decode(input.subarray(split));
    assert.deepEqual(new Float32Array([...a, ...b]), reference); assert.equal(decoder.hasTrailingI, false);
  }
});

test('full complex FFT distinguishes upper/lower RF offsets and calibrated complex amplitude', () => {
  for (const offset of [-24_000, 24_000]) {
    const frame = analyzeIqSpectrum(tone(4096, 192000, offset), 192000, 14_074_000);
    near(frame.peakFrequency, 14_074_000 + offset, 0.01); near(frame.peakDb, -6.020599913, 0.01);
    assert.equal(frame.bins.length, 4096); near(frame.minimumFrequency, 13_978_000); near(frame.maximumFrequency, 14_170_000);
    near(frame.rms, 0.5);
  }
  const iq = tone(4096, 192000, 18_321); for (let i = 0; i < iq.length; i += 2) { iq[i] += 0.3; iq[i + 1] -= 0.2; }
  const frame = analyzeIqSpectrum(iq, 192000, 100_000_000);
  near(frame.peakOffsetHz, 18_321, 1); assert.ok(frame.bins[2048]! < -75);
  assert.throws(() => analyzeIqSpectrum(new Float32Array(10), 192000, 0), RangeError);
});

function stereoWav(): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + 16), view = new DataView(buffer);
  const write = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true); view.setUint32(24, 192000, true); view.setUint32(28, 768000, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, 16, true);
  for (let i = 0; i < 8; i++) view.setInt16(44 + i * 2, i % 2 ? -8192 : 16384, true);
  return buffer;
}

test('offline IQ formats preserve stereo complex samples and reject ordinary mono audio', () => {
  const recording = decodeIq(stereoWav(), { kind: 'wav', centerFrequency: 100_000_000 });
  assert.equal(recording.sampleRate, 192000); assert.equal(recording.sampleCount, 4);
  assert.deepEqual([...recording.iq], [0.5, -0.25, 0.5, -0.25, 0.5, -0.25, 0.5, -0.25]);
  assert.throws(() => decodeIq(encodeWav(new Float32Array(100)), { kind: 'wav', centerFrequency: 0 }), /exactly two channels/);
  const f32 = new ArrayBuffer(16), view = new DataView(f32); for (let i = 0; i < 4; i++) view.setFloat32(i * 4, i % 2 ? -0.25 : 0.5, true);
  assert.deepEqual([...decodeIq(f32, { kind: 'f32le', centerFrequency: 0, sampleRate: 48000 }).iq], [0.5, -0.25, 0.5, -0.25]);
  assert.throws(() => decodeIq(Uint8Array.of(0, 1, 2).buffer, { kind: 'u8', centerFrequency: 0, sampleRate: 48000 }), /complete/);
  assert.throws(() => decodeIq(new ArrayBuffer(4), { kind: 's16le', centerFrequency: 0 }), /sample rate/);
  view.setFloat32(0, NaN, true); assert.throws(() => decodeIq(f32, { kind: 'f32le', centerFrequency: 0, sampleRate: 48000 }), /nonfinite/);
});

function extractTone(samples: Float32Array, rate: number): ReturnType<typeof analyzeSpectrum> {
  assert.ok(samples.length >= 8192); return analyzeSpectrum(samples.slice(-8192), rate);
}

test('AM envelope detector recovers known audio after complex channel selection', () => {
  const rate = 192000, iq = new Float32Array(rate * 2);
  for (let i = 0; i < rate; i++) { const t = i / rate, a = 0.5 * (1 + 0.6 * Math.sin(2 * Math.PI * 1000 * t)), phase = 2 * Math.PI * 20000 * t; iq[2 * i] = a * Math.cos(phase); iq[2 * i + 1] = a * Math.sin(phase); }
  const result = new IqDemodulator(rate, { mode: 'AM', offsetHz: 20000, bandwidthHz: 10000 }).process(iq);
  near(result.sampleRate, 48000); const measured = extractTone(result.samples, result.sampleRate);
  near(measured.peakHz, 1000, 1); assert.ok(measured.peakDb > -13 && measured.peakDb < -8);
});

test('FM phase detector recovers deviation modulation, not the RF carrier', () => {
  const rate = 192000, iq = new Float32Array(rate * 2); let phase = 0;
  for (let i = 0; i < rate; i++) { phase += 2 * Math.PI * (25000 + 1500 * Math.sin(2 * Math.PI * 1000 * i / rate)) / rate; iq[2 * i] = 0.5 * Math.cos(phase); iq[2 * i + 1] = 0.5 * Math.sin(phase); }
  const result = new IqDemodulator(rate, { mode: 'FM', offsetHz: 25000, bandwidthHz: 16000, fmDeviationHz: 2500 }).process(iq);
  const measured = extractTone(result.samples, result.sampleRate); near(measured.peakHz, 1000, 1); assert.ok(measured.peakDb > -7);
});

test('USB and LSB select their corresponding sidebands with opposite-band rejection', () => {
  const rate = 192000, iq = new Float32Array(rate * 2), center = 20000;
  for (let i = 0; i < rate; i++) {
    const a = 2 * Math.PI * (center + 1000) * i / rate, b = 2 * Math.PI * (center - 2300) * i / rate;
    iq[i * 2] = 0.3 * Math.cos(a) + 0.3 * Math.cos(b); iq[i * 2 + 1] = 0.3 * Math.sin(a) + 0.3 * Math.sin(b);
  }
  for (const mode of ['USB', 'LSB'] as const) {
    const result = new IqDemodulator(rate, { mode, offsetHz: center, bandwidthHz: 3000 }).process(iq), frame = extractTone(result.samples, result.sampleRate);
    near(frame.peakHz, mode === 'USB' ? 1000 : 2300, 1);
    const opposite = Math.round((mode === 'USB' ? 2300 : 1000) * frame.fftSize / frame.sampleRate);
    assert.ok(frame.peakDb - frame.bins[opposite]! > 30);
  }
});

test('demodulator state is continuous across arbitrary block boundaries', () => {
  const iq = tone(32768, 192000, 15000), options = { mode: 'USB', offsetHz: 14000, bandwidthHz: 3000 } as const;
  const whole = new IqDemodulator(192000, options).process(iq).samples;
  const decoder = new IqDemodulator(192000, options), pieces: number[] = [];
  for (let start = 0; start < iq.length; start += 202) pieces.push(...decoder.process(iq.subarray(start, start + 202)).samples);
  assert.equal(pieces.length, whole.length); for (let i = 0; i < pieces.length; i++) near(pieces[i]!, whole[i]!, 1e-7);
  assert.throws(() => new IqDemodulator(192000, { ...options, offsetHz: 95000 }), /Nyquist/);
});

test('speaker resampling uses actual output rate and stays continuous across chunks', () => {
  const source = new Float32Array(192000); for (let i = 0; i < source.length; i++) source[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / 192000);
  const expected = new AudioResampler(192000, 48000).process(source);
  assert.equal(expected.length, 48000); near(extractTone(expected, 48000).peakHz, 1000, 1);
  const resampler = new AudioResampler(192000, 48000), chunks: number[] = [];
  for (let start = 0; start < source.length; start += 117) chunks.push(...resampler.process(source.subarray(start, start + 117)));
  assert.deepEqual(new Float32Array(chunks), expected);
  const upward = new AudioResampler(24000, 48000).process(Float32Array.of(0, 1, 0));
  assert.deepEqual([...upward], [0, 0.5, 1, 0.5, 0]);
});
