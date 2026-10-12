import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { instantiateFtx, resampleForFtx } from '../src/digital/ftx/runtime.ts';
import { FTX_PROTOCOL } from '../src/digital/ftx/types.ts';
import { decodeWav } from '../src/audio/wav.ts';
import { analyzeSpectrum } from '../src/dsp/fft.ts';

const bytes = await readFile(new URL('../wasm/ftx.wasm', import.meta.url));
const fixture = async (name: string) => {
  const data = await readFile(new URL(`../vendor/ft8_lib/test/wav/${name}`, import.meta.url));
  return decodeWav(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
};

test('prebuilt FT8/FT4 binary and source provenance hashes match the manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../wasm/ftx-build.json', import.meta.url), 'utf8'));
  assert.equal(manifest.compiler, 'Emscripten 6.0.12');
  assert.equal(manifest.upstreamCommit, '9fec6ca39886edbf96f4f5e71edc76da5074e871');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.wasmSha256);
  for (const [name, expected] of Object.entries(manifest.sourceSha256)) {
    const source = await readFile(new URL(`../${name}`, import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'), expected, `${name} changed without rebuilding the modem`);
  }
});

test('FT8/FT4 message packing and Gaussian waveforms honor published symbol and slot timing', async () => {
  const modem = await instantiateFtx(bytes);
  for (const mode of ['FT8', 'FT4'] as const) {
    const encoded = modem.encode('CQ K1ABC FN42', mode);
    const protocol = FTX_PROTOCOL[mode], wav = decodeWav(encoded.wav);
    assert.equal(encoded.message, 'CQ K1ABC FN42');
    assert.equal(encoded.tones.length, protocol.symbols);
    assert.equal(encoded.samples.length, Math.round(protocol.symbolSeconds * protocol.symbols * encoded.sampleRate));
    assert.equal(encoded.samples.length / encoded.sampleRate, mode === 'FT8' ? 12.64 : 5.04);
    assert.equal(wav.duration, protocol.slotSeconds);
    assert.equal(encoded.startDelaySeconds, mode === 'FT8' ? 0.5 : 0.452);
    assert.ok(wav.samples.subarray(0, Math.round(encoded.startDelaySeconds * wav.sampleRate)).every(sample => sample === 0));
    assert.ok(encoded.samples.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 0.200001));
    assert.equal(Buffer.from(encoded.payload).toString('hex'), '000000204def1a8a1988');
    if (mode === 'FT8') for (const offset of [0, 36, 72]) assert.deepEqual(Array.from(encoded.tones.slice(offset, offset + 7)), [3, 1, 4, 0, 6, 5, 2]);
    else {
      const costas = [[0, 1, 3, 2], [1, 0, 2, 3], [2, 3, 1, 0], [3, 2, 0, 1]];
      for (let group = 0; group < 4; group++) assert.deepEqual(Array.from(encoded.tones.slice(1 + 33 * group, 5 + 33 * group)), costas[group]);
    }
    const decoded = modem.decode(wav.samples, wav.sampleRate, mode);
    assert.ok(decoded.some(message => message.text === 'CQ K1ABC FN42'));
    const message = decoded.find(message => message.text === 'CQ K1ABC FN42')!;
    assert.ok(Math.abs(message.audioHz - 1000) < 1);
    assert.ok(Math.abs(message.timeOffsetSeconds - encoded.startDelaySeconds) < protocol.symbolSeconds / 2);
  }
});

test('FT8/FT4 encode real standard exchanges and explicit thirteen-character free text', async () => {
  const modem = await instantiateFtx(bytes);
  for (const mode of ['FT8', 'FT4'] as const) {
    for (const [message, freeText] of [['W9XYZ K1ABC R-07', false], ['W9XYZ K1ABC RR73', false], ['TNX BOB 73', true]] as const) {
      const encoded = modem.encode(message, mode, { freeText });
      const wav = decodeWav(encoded.wav);
      assert.ok(modem.decode(wav.samples, wav.sampleRate, mode).some(result => result.text === message));
    }
  }
  assert.throws(() => modem.encode('THIS MESSAGE IS TOO LONG', 'FT8', { freeText: true }), /13 characters/);
  assert.throws(() => modem.encode('CQ K1ABC ZZ99', 'FT8'), /would decode|cannot pack/);
  assert.throws(() => modem.encode('CQ K1ABC FN42', 'FT4', { audioHz: 2999 }), /tone set/);
  assert.throws(() => modem.encode('HELLO🙂', 'FT8', { freeText: true }), /supported standard/);
});

test('real WASM LDPC+CRC decoder resolves independent recorded FT8 reference audio', async () => {
  const modem = await instantiateFtx(bytes), wav = await fixture('191111_110145.wav');
  const messages = modem.decode(wav.samples, wav.sampleRate, 'FT8');
  assert.ok(messages.some(message => message.text === 'GJ0KYZ RK9AX MO05'));
  const reference = messages.find(message => message.text === 'GJ0KYZ RK9AX MO05')!;
  assert.ok(Math.abs(reference.audioHz - 1234) < 7);
  assert.ok(reference.syncScore >= 10);
});

test('real WASM FT4 decoder resolves official WSJT-X independent sample', async () => {
  const source = await readFile(new URL('../vendor/ft8_lib/test/wav/wsjtx-ft4-000000_000002.wav', import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), 'd9e91fa04ba138a7b9f41b4103823c77ca1c3a9775101f6b14d60935bcd3813b');
  const modem = await instantiateFtx(bytes), wav = await fixture('wsjtx-ft4-000000_000002.wav');
  const messages = modem.decode(wav.samples, wav.sampleRate, 'FT4');
  assert.ok(messages.some(message => message.text === 'WD9IGY KX1X 73'));
  assert.ok(messages.some(message => message.text === 'CQ RU W1QA FN32'));
  assert.ok(messages.length >= 5);
});

test('48 kHz input is bandlimited to 12 kHz and rejects strong out-of-band alias tones', async () => {
  const input = Float32Array.from({ length: 48000 }, (_, index) => Math.sin(2 * Math.PI * 1000 * index / 48000) + 0.5 * Math.sin(2 * Math.PI * 14000 * index / 48000));
  const resampled = resampleForFtx(input, 48000);
  assert.equal(resampled.length, 12000);
  const spectrum = analyzeSpectrum(resampled.slice(4000, 6048), 12000);
  const alias = spectrum.bins[Math.round(2000 * 2048 / 12000)];
  assert.ok(alias < spectrum.peakDb - 50);
  const modem = await instantiateFtx(bytes), encoded = modem.encode('CQ K1ABC FN42', 'FT4', { sampleRate: 48000 });
  const wav = decodeWav(encoded.wav);
  assert.ok(modem.decode(wav.samples, wav.sampleRate, 'FT4').some(result => result.text === 'CQ K1ABC FN42'));
  assert.deepEqual(modem.decode(new Float32Array(180000), 12000, 'FT8'), []);
  assert.throws(() => resampleForFtx(new Float32Array(1), 1000), /6 to 192/);
});
