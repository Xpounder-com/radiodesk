import test from 'node:test';
import assert from 'node:assert/strict';
import { FtxSession, type FtxModem, type FtxPacket, type FtxDecoded } from '../src/operating/ftx-session.ts';
import { instantiateFtx } from '../src/digital/ftx/runtime.ts';
import { readFile } from 'node:fs/promises';
import { decodeWav } from '../src/audio/wav.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const options = { audioHz: 1000, volume: 0.2, freeText: false };
const packet = (message = 'CQ K1ABC FN42'): FtxPacket => ({ message, mode: 'FT8', samples: new Float32Array(151680), sampleRate: 12000, tones: new Uint8Array(79), payload: new Uint8Array(10), wav: new ArrayBuffer(44), slotSeconds: 15, signalSeconds: 12.64, startDelaySeconds: 0.5 });
const decoded: FtxDecoded[] = [{ text: 'CQ K1ABC FN42', mode: 'FT8', audioHz: 1000, timeOffsetSeconds: 0.5, syncScore: 20 }];

test('mode changes discard pending prepared packets without replacing the new mode status with an old error', async () => {
  const encoding = deferred<FtxPacket>();
  const modem: FtxModem = { encode: () => encoding.promise, decode: async () => [], dispose() {} };
  const session = new FtxSession(async () => modem);
  const preparing = session.prepare('CQ K1ABC FN42', options);
  const rejection = assert.rejects(preparing, /canceled or superseded/);
  await settle(); session.configure('FT4', 'sdr'); encoding.resolve(packet()); await rejection;
  assert.equal(session.getState().mode, 'FT4'); assert.equal(session.getState().prepared, null);
  assert.equal(session.getState().status, 'Ready'); assert.equal(session.getState().error, ''); assert.equal(session.getState().busy, false);
  await session.dispose();
});

test('the newest preparation wins and an older completion cannot clear busy or overwrite its packet', async () => {
  const first = deferred<FtxPacket>(), second = deferred<FtxPacket>(); let calls = 0;
  const modem: FtxModem = { encode: () => (++calls === 1 ? first.promise : second.promise), decode: async () => [], dispose() {} };
  const session = new FtxSession(async () => modem);
  const old = session.prepare('CQ FIRST', options), rejection = assert.rejects(old, /superseded/); await settle();
  const latest = session.prepare('CQ SECOND', options); await settle(); second.resolve(packet('CQ SECOND')); await latest;
  assert.equal(session.getState().prepared?.message, 'CQ SECOND'); assert.equal(session.getState().busy, true);
  first.resolve(packet('CQ FIRST')); await rejection;
  assert.equal(session.getState().prepared?.message, 'CQ SECOND'); assert.equal(session.getState().busy, false); await session.dispose();
});

test('receive startup and source priming do not invalidate a same-mode message being prepared', async () => {
  const encoding = deferred<FtxPacket>();
  const modem: FtxModem = { encode: () => encoding.promise, decode: async () => [], dispose() {} };
  const session = new FtxSession(async () => modem), preparing = session.prepare('CQ K1ABC FN42', options);
  await settle(); session.startReceive(); session.feed(new Float32Array(1200), 12000, 100, 'receiver', 'mic:1:0', true);
  encoding.resolve(packet()); await preparing; assert.equal(session.getState().prepared?.message, 'CQ K1ABC FN42'); await session.dispose();
});

test('a discontinuity suppresses old live decodes and busy receive windows are counted rather than queued', async () => {
  const decoding = deferred<FtxDecoded[]>(); let decodeCalls = 0;
  const modem: FtxModem = { encode: async () => packet(), decode: () => { decodeCalls++; return decoding.promise; }, dispose() {} };
  const session = new FtxSession(async () => modem); session.startReceive();
  session.feed(new Float32Array(180000), 12000, 15000, 'receiver', 'mic:1:0', true);
  session.feed(new Float32Array(180000), 12000, 30000, 'receiver', 'mic:1:0', true); await settle();
  assert.equal(decodeCalls, 1);
  session.feed(new Float32Array(1200), 12000, 30100, 'receiver', 'mic:1:0', true);
  assert.ok(session.getState().skipped >= 1);
  session.feed(new Float32Array(1200), 12000, 30300, 'receiver', 'mic:1:1', true);
  decoding.resolve(decoded); await settle();
  assert.equal(session.getState().messages.length, 0); assert.equal(session.getState().busy, false); await session.dispose();
});

test('manual import results can complete while live receive is toggled, with correct overlapping busy state', async () => {
  const decoding = deferred<FtxDecoded[]>(), encoding = deferred<FtxPacket>();
  const modem: FtxModem = { encode: () => encoding.promise, decode: () => decoding.promise, dispose() {} };
  const session = new FtxSession(async () => modem);
  const imported = session.decodeWindow(new Float32Array(180000), 12000, 15000);
  const preparing = session.prepare('CQ K1ABC FN42', options); await settle(); session.startReceive();
  encoding.resolve(packet()); await preparing; assert.equal(session.getState().busy, true);
  decoding.resolve(decoded); assert.equal((await imported).length, 1); assert.equal(session.getState().busy, false); await session.dispose();
});

test('disposing during modem loading prevents a late loader from starting encode or resurrecting a session', async () => {
  const loading = deferred<FtxModem>(); let encodes = 0, disposals = 0;
  const session = new FtxSession(() => loading.promise);
  const preparing = session.prepare('CQ K1ABC FN42', options), rejected = assert.rejects(preparing, /canceled or superseded/);
  const disposing = session.dispose();
  loading.resolve({ encode: async () => { encodes++; return packet(); }, decode: async () => [], dispose: () => { disposals++; } });
  await rejected; await disposing; assert.equal(encodes, 0); assert.equal(disposals, 1);
  assert.equal(session.getState().busy, false); assert.equal(session.getState().status, 'Closed');
  await assert.rejects(session.decodeWindow(new Float32Array(1), 12000, 0), /disposed/);
});

test('a continuous48kHz receive stream crosses the UTCcollector and realWASM FT4decoder', async () => {
  const runtime = await instantiateFtx(await readFile(new URL('../wasm/ftx.wasm', import.meta.url)));
  const waveform = decodeWav(runtime.encode('CQ K1ABC FN42', 'FT4', { sampleRate: 48000 }).wav);
  const modem: FtxModem = { encode: async (message, mode, settings) => runtime.encode(message, mode, settings), decode: async (samples, rate, mode) => runtime.decode(samples, rate, mode), dispose: () => runtime.reset() };
  const session = new FtxSession(async () => modem); session.configure('FT4', 'receiver'); session.startReceive();
  for (let offset = 0; offset < waveform.samples.length; offset += 512) {
    const chunk = waveform.samples.subarray(offset, Math.min(waveform.samples.length, offset + 512));
    session.feed(chunk, 48000, (offset + chunk.length) / 48, 'receiver', 'known-sample-clock:0', true);
  }
  session.feed(new Float32Array(512), 48000, 7500 + 512 / 48, 'receiver', 'known-sample-clock:0', true);
  await settle();
  assert.ok(session.getState().messages.some(message => message.text === 'CQ K1ABC FN42'));
  assert.equal(session.getState().messages[0].utc, '1970-01-01T00:00:00.000Z'); await session.dispose();
});
