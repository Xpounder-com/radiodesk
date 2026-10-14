import test from 'node:test';
import assert from 'node:assert/strict';
import { RadioController, type RadioTransmitPermit } from '../src/radio/controller.ts';
import { HamlibRadioDriver, validateHamlibEndpoint, validateHamlibHello, validateHamlibCapabilities, type HamlibSocket } from '../src/radio/hamlib.ts';
import { createRadioDriver } from '../src/radio/registry.ts';
import type { DriverTransmitPermit, RadioCapabilities, RadioSnapshot } from '../src/radio/driver.ts';

const endpoint = 'ws://127.0.0.1:8766/radio?token=test_token_0123456789';
const caps: RadioCapabilities = { frequency: true, mode: true, ptt: true, pttReadback: true, receiveOnly: false, simulated: false, modes: ['USB', 'LSB', 'CW', 'CW-R', 'DATA-USB', 'DATA-LSB', 'FM', 'WFM'], minFrequency: 10_000, maxFrequency: 1_200_000_000, digitalModes: ['USB', 'DATA-USB'], splitReadback: true, hardwareReceiveOnly: false, pttRoute: 'RIG', pttRouteVerified: true, cacheTimeoutMs: 0, freshReadback: true };
function hello(options: { capabilities?: Partial<RadioCapabilities>; snapshot?: Partial<RadioSnapshot>; model?: string; name?: string; configuredModelName?: string } = {}) {
  return { protocol: 'radiodesk-hamlib-v1', name: options.name ?? 'Configured test radio', model: options.model ?? '1234', configuredModelName: options.configuredModelName ?? 'Configured VHF transceiver', identitySource: 'hamlib-configured', capabilities: { ...caps, ...options.capabilities }, snapshot: { frequency: 144_200_000, mode: 'USB', ptt: false, txStatus: 'rx', split: false, ...options.snapshot } };
}
type Request = { id: number; op: string; [key: string]: unknown };
class FakeSocket extends EventTarget implements HamlibSocket {
  readyState = 0;
  bufferedAmount = 0;
  requests: Request[] = [];
  ignored = new Set<string>();
  state: RadioSnapshot;
  greeting: ReturnType<typeof hello>;
  rejected = new Map<string, string>();
  refuseFrequency = false;
  constructor(greeting = hello(), autoOpen = true) {
    super(); this.greeting = greeting; this.state = { ...greeting.snapshot } as RadioSnapshot;
    if (autoOpen) queueMicrotask(() => this.open());
  }
  open(): void { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('Socket closed');
    const request = JSON.parse(data) as Request; this.requests.push(request);
    if (this.ignored.has(request.op)) return;
    if (this.rejected.has(request.op)) { queueMicrotask(() => this.message({ id: request.id, ok: false, error: this.rejected.get(request.op) })); return; }
    let result: unknown;
    if (request.op === 'hello') result = this.greeting;
    else if (request.op === 'heartbeat') result = { alive: true };
    else if (request.op === 'release') { if (this.state.txStatus !== 'external-tx') this.state = { ...this.state, txStatus: 'rx', ptt: false }; result = this.state.txStatus; }
    else if (request.op === 'ptt') { this.state = { ...this.state, ptt: true, txStatus: 'cat-tx' }; result = 'cat-tx'; }
    else { if (request.op === 'frequency' && !this.refuseFrequency) this.state.frequency = request.value as number; if (request.op === 'mode') this.state.mode = request.value as string; result = { ...this.state }; }
    queueMicrotask(() => this.reply(request.id, result));
  }
  reply(id: number, result: unknown): void { this.message({ id, ok: true, result }); }
  message(data: unknown): void { this.dispatchEvent(Object.assign(new Event('message'), { data: typeof data === 'string' ? data : JSON.stringify(data) })); }
  close(): void { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
async function flush(): Promise<void> { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function connected(greeting = hello(), timeoutMs = 100) {
  let socket!: FakeSocket;
  const radio = new RadioController({ pollIntervalMs: 0, timeoutMs, webSocketFactory: () => socket = new FakeSocket(greeting) });
  await radio.connectHamlib(endpoint); return { radio, socket };
}

test('Hamlib endpoints restrict plaintext to loopback and never reflect credentials', () => {
  assert.equal(validateHamlibEndpoint(endpoint), endpoint);
  assert.match(validateHamlibEndpoint('wss://example.test/radio?token=test_token_0123456789'), /^wss:/);
  for (const value of ['ws://example.test/radio?token=test_token_0123456789', 'ws://127.0.0.1:8766/', 'http://127.0.0.1/radio?token=test_token_0123456789', `${endpoint}#secret`, `${endpoint}&raw=TX1`, `${endpoint}&token=duplicate_0123456789`, 'ws://user:secret@localhost/radio?token=test_token_0123456789', 'ws://localhost/radio?token=short', 'invalid credential']) {
    assert.throws(() => validateHamlibEndpoint(value), (error: Error) => { assert.equal(error.message.includes('test_token'), false); assert.equal(error.message.includes('secret'), false); return true; });
  }
});

test('driver registry constructs real drivers and rejects an unregistered runtime id', async () => {
  const radio = new RadioController();
  assert.deepEqual(radio.getDrivers().map(driver => driver.id), ['simulator', 'ft891', 'hamlib']);
  assert.throws(() => createRadioDriver('constructor' as 'hamlib'), /Unknown/);
  const simulator = createRadioDriver('simulator'); assert.equal((await simulator.identify()).capabilities.simulated, true); await simulator.close();
  assert.throws(() => createRadioDriver('ft891'), /session/);
});

test('configured Hamlib identity and per-model capabilities replace FT-891 assumptions', async () => {
  const { radio, socket } = await connected();
  assert.equal(radio.getState().model, 'Configured VHF transceiver'); assert.equal(radio.getState().backendId, '1234'); assert.equal(radio.getState().identitySource, 'hamlib-configured');
  assert.equal(radio.getState().verified, true); assert.equal(radio.getCapabilities().pttReadback, true);
  assert.equal(radio.getCapabilities().maxFrequency, 1_200_000_000); assert.deepEqual(socket.requests.map(request => request.op), ['hello']);
  await radio.setFrequency(432_100_000); await radio.setMode('wfm');
  assert.equal(radio.getState().frequency, 432_100_000); assert.equal(radio.getState().mode, 'WFM');
  assert.equal(socket.requests.find(request => request.op === 'frequency')?.value, 432_100_000);
  assert.equal(socket.requests.find(request => request.op === 'mode')?.value, 'WFM');
  const copy = radio.getCapabilities(); copy.modes.push('INJECTED'); copy.digitalModes.length = 0;
  assert.equal(radio.getCapabilities().modes.includes('INJECTED'), false); assert.equal(radio.getCapabilities().digitalModes.includes('USB'), true);
  await radio.disconnect();
});

test('known Dummy model is simulated, keeps a human model name, and never claims hardware verification', async () => {
  const { radio, socket } = await connected(hello({ model: '1', name: 'Hamlib Dummy', configuredModelName: 'Dummy', capabilities: { simulated: true } }));
  assert.equal(radio.getCapabilities().simulated, true); assert.equal(radio.getState().verified, false); assert.equal(radio.getState().model, 'Dummy'); assert.equal(radio.getState().driver, 'Hamlib Dummy');
  assert.equal(socket.requests.some(request => request.op === 'ptt'), false);
  await radio.disconnect();
  assert.throws(() => validateHamlibHello(hello({ capabilities: { simulated: true } })), /known Hamlib Dummy/);
});

test('configured model labels remain data and invalid control characters are rejected', () => {
  const label = '<img src=x onerror=alert(1)>';
  assert.equal(validateHamlibHello(hello({ configuredModelName: label })).identity.model, label);
  assert.throws(() => validateHamlibHello(hello({ configuredModelName: 'Model\nFake' })), /configured model/);
});

test('malformed flags, limits, mode lists, and missing PTT readback fail closed', async () => {
  const malformed: unknown[] = [
    { ...caps, pttReadback: false }, { ...caps, ptt: 'true' }, { ...caps, minFrequency: 0 }, { ...caps, maxFrequency: 1000 },
    { ...caps, modes: ['USB', 'USB'] }, { ...caps, modes: ['USB;TX1'] }, { ...caps, digitalModes: ['NO-SUCH-MODE'] },
    { ...caps, receiveOnly: true }, { ...caps, hardwareReceiveOnly: true }, { ...caps, splitReadback: 'true' },
  ];
  for (const value of malformed) assert.throws(() => validateHamlibCapabilities(value));
  const greeting = hello(); greeting.capabilities.modes = ['USB;TX1'];
  let socket!: FakeSocket;
  const radio = new RadioController({ pollIntervalMs: 0, webSocketFactory: () => socket = new FakeSocket(greeting) });
  await assert.rejects(radio.connectHamlib(endpoint), /invalid/); assert.equal(radio.getState().connected, false); assert.equal(socket.readyState, 3); assert.equal(radio.getCapabilities().ptt, false);
});

test('PTT hello requires complete verified-route and uncached-readback safety metadata', async () => {
  for (const key of ['pttRoute', 'pttRouteVerified', 'cacheTimeoutMs', 'freshReadback'] as const) {
    const greeting = hello(); delete greeting.capabilities[key];
    assert.throws(() => validateHamlibHello(greeting), /verified CAT route|uncached/);
  }
  for (const unsafe of [
    { pttRouteVerified: false }, { cacheTimeoutMs: null }, { cacheTimeoutMs: 10 }, { cacheTimeoutMs: NaN }, { freshReadback: false },
    { pttRoute: 'RTS' }, { pttRoute: 'DTR' }, { pttRoute: 'None' }, { pttRoute: 'UNKNOWN' }, { pttRoute: null },
  ]) assert.throws(() => validateHamlibHello(hello({ capabilities: unsafe })), /verified CAT route|uncached/);
  let socket!: FakeSocket;
  const greeting = hello({ capabilities: { cacheTimeoutMs: 100 } });
  const radio = new RadioController({ pollIntervalMs: 0, webSocketFactory: () => socket = new FakeSocket(greeting) });
  await assert.rejects(radio.connectHamlib(endpoint), /invalid/);
  assert.equal(radio.getCapabilities().ptt, false); assert.equal(socket.readyState, 3);
  assert.equal(socket.requests.some(request => request.op === 'ptt'), false);
});

test('only the known simulated Dummy may use None routing, while read-only metadata never enables PTT', () => {
  const dummy = hello({ model: '1', configuredModelName: 'Dummy', capabilities: { simulated: true, pttRoute: 'None' } });
  assert.equal(validateHamlibHello(dummy).capabilities.ptt, true);
  dummy.model = '1234'; assert.throws(() => validateHamlibHello(dummy), /known Hamlib Dummy/);
  assert.equal(validateHamlibHello(hello({ capabilities: { pttRoute: 'RIGMICDATA' } })).capabilities.pttRoute, 'RIGMICDATA');
  const readonly = hello({ capabilities: { ptt: false, receiveOnly: true, pttRoute: 'DTR', pttRouteVerified: false, cacheTimeoutMs: null, freshReadback: false } });
  assert.equal(validateHamlibHello(readonly).capabilities.ptt, false);
  for (const key of ['pttRoute', 'pttRouteVerified', 'cacheTimeoutMs', 'freshReadback'] as const) delete readonly.capabilities[key];
  assert.equal(validateHamlibHello(readonly).capabilities.ptt, false);
});

test('unsupported frequency/mode and arbitrary mode strings never reach the bridge', async () => {
  const { radio, socket } = await connected();
  await assert.rejects(radio.setFrequency(2_000_000_000), /integer/);
  await assert.rejects(radio.setMode('USB;TX1'), /Unsupported/);
  await assert.rejects(radio.setMode('RTTY'), /Unsupported/);
  assert.deepEqual(socket.requests.map(request => request.op), ['hello']); await radio.disconnect();
});

test('discontinuous receive ranges reject gap tuning before any backend command and remain immutable to callers', async () => {
  const ranges = [{ min: 10_000, max: 30_000_000 }, { min: 144_000_000, max: 148_000_000 }];
  const { radio, socket } = await connected(hello({ capabilities: { maxFrequency: 148_000_000, frequencyRanges: ranges } }));
  const copy = radio.getCapabilities(); copy.frequencyRanges![0]!.max = 143_999_999;
  assert.equal(radio.getCapabilities().frequencyRanges![0]!.max, 30_000_000);
  await assert.rejects(radio.setFrequency(70_000_000), /gap/);
  assert.deepEqual(socket.requests.map(request => request.op), ['hello']);
  await radio.setFrequency(7_074_000); assert.equal(radio.getState().frequency, 7_074_000); await radio.disconnect();
  for (const frequencyRanges of [[], [{ min: 10_000, max: 200_000_000 }], [{ min: 10_000, max: 100_000_000 }, { min: 90_000_000, max: 148_000_000 }], [{ min: 11_000, max: 148_000_000 }], [{ min: 10_000.1, max: 148_000_000 }], [{ min: 148_000_000, max: 144_000_000 }]]) assert.throws(() => validateHamlibCapabilities({ ...caps, maxFrequency: 148_000_000, frequencyRanges }));
});

test('rejected frequency request publishes the actual readback rather than inventing a tune', async () => {
  const { radio, socket } = await connected(); socket.refuseFrequency = true;
  await assert.rejects(radio.setFrequency(432_100_000), /not accepted/); assert.equal(radio.getState().frequency, 144_200_000); await radio.disconnect();
});

test('receive-only policy blocks permits while preserving independent PTT readback', async () => {
  const { radio, socket } = await connected(hello({ capabilities: { ptt: false, receiveOnly: true } }));
  assert.equal(radio.getCapabilities().ptt, false); assert.equal(radio.getCapabilities().pttReadback, true);
  assert.throws(() => radio.acquireTransmitPermit(() => true), /PTT/);
  await assert.rejects(radio.setPtt(true, { kind: 'radiodesk-operator-transmit' } as RadioTransmitPermit), /permit/);
  await radio.setFrequency(432_100_000); assert.equal(socket.requests.some(request => request.op === 'ptt'), false); await radio.disconnect();
});

test('hardware receiver proof permits tuning without GETPTT but never permits transmit', async () => {
  const { radio } = await connected(hello({ capabilities: { ptt: false, pttReadback: false, receiveOnly: true, hardwareReceiveOnly: true, splitReadback: false }, snapshot: { split: null } }));
  await radio.setFrequency(432_100_000); assert.equal(radio.getState().txStatus, 'rx'); assert.equal(radio.getCapabilities().hardwareReceiveOnly, true);
  assert.throws(() => radio.acquireTransmitPermit(() => true), /PTT/); await radio.disconnect();
});

test('lack of GETPTT does not turn an unknown transceiver into confirmed RX', async () => {
  const greeting = hello({ capabilities: { ptt: false, pttReadback: false, receiveOnly: true, frequency: false, mode: false, splitReadback: false }, snapshot: { txStatus: 'unknown', split: null } });
  const { radio, socket } = await connected(greeting);
  assert.equal(radio.getState().txStatus, 'unknown'); assert.equal(radio.getCapabilities().frequency, false);
  await assert.rejects(radio.setFrequency(432_100_000), /confirm receive/); assert.deepEqual(socket.requests.map(request => request.op), ['hello']); await radio.disconnect();
  assert.throws(() => validateHamlibCapabilities({ ...greeting.capabilities, frequency: true }), /Unconfirmed/);
});

test('PTT is opaque, rechecks expected state, and forwards the bounded operator duration', async () => {
  const { radio, socket } = await connected();
  assert.throws(() => radio.acquireTransmitPermit(() => true, 31), /1 to 30/);
  const permit = radio.acquireTransmitPermit(() => true, 15); await radio.setPtt(true, permit);
  const key = socket.requests.find(request => request.op === 'ptt')!;
  assert.equal(key.maximumSeconds, 15); assert.deepEqual(key.expected, { frequency: 144_200_000, mode: 'USB' }); assert.equal(radio.getState().txStatus, 'cat-tx');
  assert.equal(Object.hasOwn(key, 'keyBeforeUtcMs'), false, 'manual holds have no scheduled keying deadline');
  await assert.rejects(radio.setFrequency(432_100_000), /Release PTT/);
  await radio.emergencyReceive(); assert.equal(radio.getState().txStatus, 'rx'); await radio.disconnect();
});

test('scheduled controller authority forwards the keying deadline as a separate bridge field', async () => {
  const { radio, socket } = await connected(); const keyBeforeUtcMs = Date.now() + 10_000;
  assert.throws(() => radio.acquireTransmitPermit(() => true, 10, NaN), /deadline/);
  const permit = radio.acquireTransmitPermit(() => true, 15, keyBeforeUtcMs); await radio.setPtt(true, permit);
  const key = socket.requests.find(request => request.op === 'ptt')!;
  assert.equal(key.keyBeforeUtcMs, keyBeforeUtcMs);
  assert.deepEqual(Object.keys(key.expected as object).sort(), ['frequency', 'mode']);
  await radio.emergencyReceive(); await radio.disconnect();
});

test('an expired scheduled controller authority cannot issue a PTT RPC', async (t) => {
  let now = 1_800_000_000_000; t.mock.method(Date, 'now', () => now);
  const { radio, socket } = await connected(); const permit = radio.acquireTransmitPermit(() => true, 10, now + 100);
  now += 101; await assert.rejects(radio.setPtt(true, permit), /current operator/);
  assert.deepEqual(socket.requests.map(request => request.op), ['hello']); await radio.disconnect();
});

test('a fresh Hamlib readback finishing after its UTC key deadline cannot send PTT', async (t) => {
  let now = 1_800_000_000_000; t.mock.method(Date, 'now', () => now);
  const socket = new FakeSocket(); const driver = new HamlibRadioDriver(endpoint, { socketFactory: () => socket, timeoutMs: 100 }); await driver.identify();
  const permit = driver.acquireTransmitPermit(() => true); socket.ignored.add('read');
  const keying = assert.rejects(driver.setPtt(true, permit, { frequency: 144_200_000, mode: 'USB' }, 10, now + 100), /deadline was missed/); await flush();
  now += 101; socket.reply(socket.requests.find(request => request.op === 'read')!.id, { ...socket.state }); await keying;
  assert.equal(socket.requests.some(request => request.op === 'ptt'), false); await driver.close();
});

test('physical state changes after issuing a permit block keying before any ptt request', async () => {
  const { radio, socket } = await connected(); const permit = radio.acquireTransmitPermit(() => true);
  socket.state.frequency = 432_100_000;
  await assert.rejects(radio.setPtt(true, permit), /changed after arming/); assert.equal(socket.requests.some(request => request.op === 'ptt'), false);
  await radio.emergencyReceive(); await radio.disconnect();
});

test('split capability and current simplex readback gate Hamlib PTT', async () => {
  assert.throws(() => validateHamlibHello(hello({ capabilities: { splitReadback: false }, snapshot: { split: null } })), /simplex/);
  assert.throws(() => validateHamlibHello(hello({ snapshot: { split: true } })), /simplex/);
  const { radio, socket } = await connected(); const permit = radio.acquireTransmitPermit(() => true); socket.state.split = true;
  await radio.refresh(); assert.equal(radio.getCapabilities().ptt, false);
  assert.throws(() => radio.acquireTransmitPermit(() => true), /PTT/);
  await assert.rejects(radio.setPtt(true, permit), /simplex/); assert.equal(socket.requests.some(request => request.op === 'ptt'), false);
  await radio.emergencyReceive(); await radio.disconnect();
});

test('priority RX bypasses a delayed read and canceled queued PTT never keys', async () => {
  const socket = new FakeSocket(); const driver = new HamlibRadioDriver(endpoint, { socketFactory: () => socket, timeoutMs: 100 }); await driver.identify();
  socket.ignored.add('read'); const reading = driver.read(); await flush();
  const pendingRead = socket.requests.find(request => request.op === 'read')!;
  const permit = driver.acquireTransmitPermit(() => true); const keying = assert.rejects(driver.setPtt(true, permit, { frequency: 144_200_000, mode: 'USB' }, 10), /permit/);
  await driver.emergencyReceive(); assert.equal(socket.requests.at(-1)!.op, 'release');
  socket.ignored.delete('read'); socket.reply(pendingRead.id, { ...socket.state }); await reading; await keying;
  assert.equal(socket.requests.some(request => request.op === 'ptt'), false); await driver.close();
});

test('an expired predicate is checked after a delayed fresh read before sending PTT', async () => {
  const socket = new FakeSocket(); const driver = new HamlibRadioDriver(endpoint, { socketFactory: () => socket, timeoutMs: 100 }); await driver.identify();
  let valid = true; const permit = driver.acquireTransmitPermit(() => valid); socket.ignored.add('read');
  const keying = assert.rejects(driver.setPtt(true, permit, { frequency: 144_200_000, mode: 'USB' }, 10), /canceled/); await flush();
  valid = false; socket.reply(socket.requests.find(request => request.op === 'read')!.id, { ...socket.state }); await keying;
  assert.equal(socket.requests.some(request => request.op === 'ptt'), false); await driver.close();
});

test('late PTT acknowledgement after emergency RX cannot relatch controller state', async () => {
  const { radio, socket } = await connected(); const permit = radio.acquireTransmitPermit(() => true);
  socket.ignored.add('ptt'); const keying = radio.setPtt(true, permit); await flush(); const request = socket.requests.find(request => request.op === 'ptt')!;
  await radio.emergencyReceive(); socket.reply(request.id, 'cat-tx'); await keying;
  assert.equal(radio.getState().txStatus, 'rx'); assert.equal(radio.getState().ptt, false); await radio.disconnect();
});

test('priority release retires a pending PTT RPC so fresh reads do not wait for its late acknowledgement', async () => {
  const { radio, socket } = await connected(); const permit = radio.acquireTransmitPermit(() => true);
  socket.ignored.add('ptt'); const keying = radio.setPtt(true, permit); await flush(); const old = socket.requests.find(request => request.op === 'ptt')!;
  await radio.emergencyReceive(); await keying;
  await radio.refresh(); assert.equal(radio.getState().txStatus, 'rx');
  socket.reply(old.id, 'cat-tx'); await flush(); assert.equal(radio.getState().txStatus, 'rx');
  assert.equal(radio.getState().connected, true); await radio.disconnect();
});

test('external PTT release never becomes a false receive confirmation', async () => {
  const { radio, socket } = await connected(); socket.state.txStatus = 'external-tx'; socket.state.ptt = true; await radio.refresh();
  await assert.rejects(radio.emergencyReceive(), /did not confirm/); assert.equal(radio.getState().txStatus, 'unknown'); assert.equal(radio.getState().ptt, true); await radio.disconnect();
});

test('malformed live readback fails closed and revokes controller permits', async () => {
  const { radio, socket } = await connected(); const permit = radio.acquireTransmitPermit(() => true); socket.state.mode = 'BAD;TX1';
  await assert.rejects(radio.refresh(), /invalid/); assert.equal(radio.getState().connected, false); assert.equal(radio.getState().txStatus, 'unknown'); assert.equal(socket.readyState, 3);
  await assert.rejects(radio.setPtt(true, permit), /permit/);
});

test('a readback timeout during transmit sends best-effort release and keeps RX unconfirmed', async () => {
  const { radio, socket } = await connected(hello(), 20); const permit = radio.acquireTransmitPermit(() => true); await radio.setPtt(true, permit);
  socket.ignored.add('read'); await assert.rejects(radio.refresh(), /timed out/);
  assert.equal(socket.requests.some(request => request.op === 'release'), true); assert.equal(socket.readyState, 3);
  assert.equal(radio.getState().connected, false); assert.equal(radio.getState().txStatus, 'unknown'); assert.equal(radio.getState().ptt, true);
  await assert.rejects(radio.setPtt(true, permit), /permit/);
});

test('timeout ignores late replies and a reconnect cannot reuse an old permit or response', async () => {
  const sockets: FakeSocket[] = [];
  const radio = new RadioController({ pollIntervalMs: 0, timeoutMs: 20, webSocketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; } });
  await radio.connectHamlib(endpoint); const oldPermit = radio.acquireTransmitPermit(() => true); sockets[0]!.ignored.add('read');
  const reading = assert.rejects(radio.refresh(), /timed out/); await flush(); const pending = sockets[0]!.requests.find(request => request.op === 'read')!; await reading;
  assert.equal(radio.getState().connected, false); assert.equal(radio.getCapabilities().ptt, false);
  await radio.connectHamlib(endpoint); sockets[0]!.reply(pending.id, { ...sockets[0]!.state, frequency: 432_100_000 }); await flush();
  assert.equal(radio.getState().frequency, 144_200_000); await assert.rejects(radio.setPtt(true, oldPermit), /permit/); await radio.disconnect();
});

test('disconnect cancels an outstanding handshake and a late hello cannot reconnect', async () => {
  let socket!: FakeSocket;
  const radio = new RadioController({ pollIntervalMs: 0, webSocketFactory: () => { socket = new FakeSocket(); socket.ignored.add('hello'); return socket; } });
  const connecting = assert.rejects(radio.connectHamlib(endpoint), /closed|canceled/); await flush(); const request = socket.requests.find(request => request.op === 'hello')!;
  await radio.disconnect(); socket.reply(request.id, hello()); await connecting; assert.equal(radio.getState().connected, false); assert.equal(radio.getCapabilities().ptt, false);
});

test('unknown and duplicate reply ids cannot satisfy a later request', async () => {
  const { radio, socket } = await connected(); socket.ignored.add('read'); const reading = radio.refresh(); await flush(); const request = socket.requests.find(request => request.op === 'read')!;
  socket.reply(1, { ...socket.state, frequency: 432_100_000 }); socket.reply(request.id + 100, { ...socket.state, frequency: 432_100_000 }); await flush();
  assert.equal(radio.getState().frequency, 144_200_000); socket.reply(request.id, { ...socket.state }); await reading; await radio.disconnect();
});

test('bridge rejection and socket errors never disclose the endpoint token', async () => {
  const { radio, socket } = await connected(); socket.rejected.set('read', `Backend failed at ${endpoint}`);
  await assert.rejects(radio.refresh(), (error: Error) => { assert.equal(error.message.includes('test_token'), false); return true; });
  assert.equal(radio.getState().error!.includes('test_token'), false); assert.equal(radio.getState().connected, false);
});

test('heartbeat runs independently of queued read work and rejects a bad heartbeat', async () => {
  const { radio, socket } = await connected(hello(), 2000);
  socket.ignored.add('read'); const reading = assert.rejects(radio.refresh(), /heartbeat|disconnected/); await flush();
  socket.ignored.add('heartbeat'); await new Promise(resolve => setTimeout(resolve, 1020));
  const heartbeat = socket.requests.find(request => request.op === 'heartbeat')!; assert.ok(heartbeat);
  socket.reply(heartbeat.id, { alive: false }); await reading; assert.equal(radio.getState().connected, false); assert.equal(radio.getState().txStatus, 'unknown');
});

test('driver-level scope forgery cannot bypass PTT and a closed driver cannot grant scopes', async () => {
  const socket = new FakeSocket(); const driver = new HamlibRadioDriver(endpoint, { socketFactory: () => socket }); await driver.identify();
  await assert.rejects(driver.setPtt(true, { kind: 'radiodesk-driver-permit' } as DriverTransmitPermit, { frequency: 144_200_000, mode: 'USB' }, 10), /permit/);
  assert.equal(socket.requests.some(request => request.op === 'ptt'), false); await driver.close(); assert.throws(() => driver.acquireTransmitPermit(() => true), /identify/);
});
