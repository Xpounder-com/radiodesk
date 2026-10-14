import test from 'node:test';
import assert from 'node:assert/strict';
import { RadioController, type RadioTransmitPermit, type RadioState } from '../src/radio/controller.ts';
import { CATSession, type CATTransmitScope } from '../src/radio/session.ts';
import { FT891Driver } from '../src/radio/ft891.ts';
import { parseFT891TransmitStatus } from '../src/radio/protocol.ts';
import { TransmitController, type ArmRequest } from '../src/transmit/controller.ts';
import type { SerialApiLike, SerialPortLike } from '../src/devices/types.ts';
import type { CATTransport } from '../src/devices/serial.ts';
import type { HamlibSocket } from '../src/radio/hamlib.ts';

class Clock {
  mono = 0;
  utc = 1_800_000_000_000;
  next = 1;
  tasks = new Map<number, { at: number; callback: () => void }>();
  setTimeout = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const id = this.next++; this.tasks.set(id, { at: this.mono + delay, callback }); return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (timer: ReturnType<typeof setTimeout>): void => { this.tasks.delete(timer as unknown as number); };
  async advance(ms: number): Promise<void> {
    const end = this.mono + ms;
    while (true) {
      const first = [...this.tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first || first[1].at > end) break;
      const diff = first[1].at - this.mono; this.mono += diff; this.utc += diff;
      this.tasks.delete(first[0]); first[1].callback(); await flush();
    }
    const remaining = end - this.mono; this.mono = end; this.utc += remaining; await flush();
  }
}

async function flush(): Promise<void> { for (let i = 0; i < 30; i++) await Promise.resolve(); }

class RigPort extends EventTarget implements SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  input: ReadableStreamDefaultController<Uint8Array> | undefined;
  commands: string[] = [];
  frequency = 14_074_000;
  mode = 'C';
  tx = '0';
  identity = '0650';
  refuseTx = false;
  malformedTxRead = false;
  ignoreTxRead = false;
  closed = false;
  delayTxWrite: (() => Promise<void>) | undefined;

  constructor() {
    super();
    this.readable = new ReadableStream({ start: (controller) => { this.input = controller; } });
    this.writable = new WritableStream({ write: async (bytes) => {
      const command = new TextDecoder().decode(bytes); this.commands.push(command);
      if (command === 'TX1;') { await this.delayTxWrite?.(); if (!this.refuseTx) this.tx = '1'; return; }
      if (command === 'TX0;') { if (this.tx !== '2') this.tx = '0'; return; }
      if (command === 'TX;' && this.ignoreTxRead) return;
      const reply = ({ 'ID;': `ID${this.identity};`, 'FA;': `FA${String(this.frequency).padStart(9, '0')};`, 'MD0;': `MD0${this.mode};`, 'EX0812;': 'EX08120;', 'EX1107;': 'EX11072;', 'TX;': this.malformedTxRead ? 'TX9;' : `TX${this.tx};` } as Record<string, string>)[command];
      if (reply) this.input!.enqueue(new TextEncoder().encode(reply));
    } });
  }
  async open(): Promise<void> {}
  async close(): Promise<void> { this.closed = true; }
  async setSignals(): Promise<void> {}
  getInfo(): Record<string, number> { return {}; }
}

const checklist = { authorizedOperator: true, frequencyAuthorized: true, antennaOrDummyLoad: true, independentFailsafe: true, audioRouteVerified: true, physicalUnverified: true };
function request(mode = 'DATA-USB', maximum = 10): ArmRequest { return { operatorCall: 'N0CALL', frequencyHz: 14_074_000, mode, maxTransmitSeconds: maximum, acknowledgements: { ...checklist } }; }

async function hardware(options: { clock?: Clock; timeoutMs?: number; port?: RigPort } = {}) {
  const port = options.port ?? new RigPort();
  const serial = new EventTarget() as SerialApiLike;
  serial.requestPort = async () => port; serial.getPorts = async () => [];
  const radio = new RadioController({ serial, pollIntervalMs: 0, timeoutMs: options.timeoutMs ?? 100 });
  await radio.connectSerial('ft891');
  const clock = options.clock ?? new Clock();
  const windowTarget = new EventTarget();
  const documentTarget = Object.assign(new EventTarget(), { hidden: false });
  const tx = new TransmitController(radio, { clock: () => clock.mono, wallClock: () => clock.utc, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, window: windowTarget, document: documentTarget });
  return { radio, tx, port, clock, windowTarget, documentTarget };
}

/** A non-Yaesu driver contract fixture; no serial, WebSocket, audio or RF hardware is opened. */
class GenericRig {
  state: RadioState = { connected: true, verified: true, frequency: 14_074_000, mode: 'USB', ptt: false, txStatus: 'rx', driver: 'Hamlib', model: 'Icom IC-7300', identitySource: 'hamlib-configured' };
  capabilities = { frequency: true, mode: true, ptt: true, pttReadback: true, receiveOnly: false, simulated: false, modes: ['USB', 'LSB', 'DATA-USB'], digitalModes: ['USB', 'DATA-USB'], minFrequency: 30_000, maxFrequency: 74_800_000 };
  listeners = new Set<(state: RadioState) => void>();
  permits = new Map<RadioTransmitPermit, () => boolean>();
  permitDurations: number[] = [];
  permitKeyBoundaries: Array<number | undefined> = [];
  refreshes = 0;
  keys = 0;
  releases = 0;
  getState(): RadioState { return { ...this.state }; }
  getCapabilities() { return { ...this.capabilities, modes: [...this.capabilities.modes], digitalModes: [...this.capabilities.digitalModes] }; }
  subscribe(listener: (state: RadioState) => void): () => void { this.listeners.add(listener); listener(this.getState()); return () => this.listeners.delete(listener); }
  emit(): void { for (const listener of this.listeners) listener(this.getState()); }
  async refresh(): Promise<RadioState> { this.refreshes++; this.emit(); return this.getState(); }
  acquireTransmitPermit(current: () => boolean, maximumSeconds: number, keyBeforeUtcMs?: number): RadioTransmitPermit { const permit = { kind: 'radiodesk-operator-transmit' } as const; this.permits.set(permit, current); this.permitDurations.push(maximumSeconds); this.permitKeyBoundaries.push(keyBeforeUtcMs); return permit; }
  revokeTransmitPermit(permit: RadioTransmitPermit): void { this.permits.delete(permit); }
  async setPtt(active: boolean, permit: RadioTransmitPermit): Promise<void> { if (!this.permits.get(permit)?.()) throw new Error('Expired generic driver permit.'); this.keys++; this.state.ptt = active; this.state.txStatus = active ? 'cat-tx' : 'rx'; this.emit(); }
  async emergencyReceive(): Promise<void> { this.releases++; this.state.ptt = false; this.state.txStatus = 'rx'; this.emit(); }
  async readTransmitStatus() { return this.state.txStatus; }
}

function genericHardware() {
  const rig = new GenericRig(), clock = new Clock();
  const tx = new TransmitController(rig as unknown as RadioController, { clock: () => clock.mono, wallClock: () => clock.utc, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  return { rig, clock, tx };
}

class DeferredHamlibSocket extends EventTarget implements HamlibSocket {
  readyState = 1;
  bufferedAmount = 0;
  ptt = false;
  commands: Array<Record<string, any>> = [];
  pendingKey: Record<string, any> | undefined;
  send(data: string): void {
    const request = JSON.parse(data); this.commands.push(request);
    const reply = (result: unknown) => queueMicrotask(() => this.respond(request.id, result));
    if (request.op === 'hello') reply({ protocol: 'radiodesk-hamlib-v1', name: 'Icom IC-7300 fixture', configuredModelName: 'IC-7300', model: '3073', identitySource: 'hamlib-configured', capabilities: { frequency: true, mode: true, ptt: true, pttReadback: true, splitReadback: true, receiveOnly: false, simulated: false, modes: ['USB', 'DATA-USB'], digitalModes: ['USB', 'DATA-USB'], minFrequency: 30_000, maxFrequency: 74_800_000, pttRoute: 'RIG', pttRouteVerified: true, cacheTimeoutMs: 0, freshReadback: true }, snapshot: this.snapshot() });
    else if (request.op === 'read') reply(this.snapshot());
    else if (request.op === 'ptt') { this.ptt = true; this.pendingKey = request; }
    else if (request.op === 'release') { this.ptt = false; reply('rx'); }
    else if (request.op === 'heartbeat') reply({ alive: true });
    else throw new Error(`Unexpected synthetic Hamlib request ${request.op}`);
  }
  private snapshot() { return { frequency: 14_074_000, mode: 'USB', ptt: this.ptt, txStatus: this.ptt ? 'cat-tx' : 'rx', split: false }; }
  respond(id: number, result: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, ok: true, result }) })); }
  close(): void { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('late Hamlib PTT acknowledgement after operator release cannot replace confirmed receive or relatch transmit', async () => {
  const socket = new DeferredHamlibSocket(), radio = new RadioController({ pollIntervalMs: 0, webSocketFactory: () => socket });
  await radio.connectHamlib('ws://127.0.0.1:8766/radio?token=abcdefghijklmnop');
  const clock = new Clock(), tx = new TransmitController(radio, { clock: () => clock.mono, wallClock: () => clock.utc, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  try {
    await tx.arm(request('USB')); const holding = tx.holdPTT(); await flush();
    assert.ok(socket.pendingKey, 'the JSON PTT request has reached the synthetic backend');
    assert.equal(tx.getState().status, 'pending');
    await tx.releasePTT(); assert.equal(tx.getState().rxConfirmed, true); assert.equal(radio.getState().txStatus, 'rx');
    socket.respond(socket.pendingKey!.id, 'cat-tx'); await holding; await flush();
    assert.equal(radio.getState().txStatus, 'rx'); assert.equal(radio.getState().ptt, false);
    assert.equal(tx.getState().status, 'armed'); assert.equal(tx.getState().rxConfirmed, true);
    assert.equal(socket.commands.filter(command => command.op === 'ptt').length, 1);
  } finally { await tx.dispose(); await radio.disconnect(); }
});

test('a pending Hamlib scheduled key is canceled before the audio boundary even while its acknowledgement is delayed', async () => {
  const socket = new DeferredHamlibSocket(), radio = new RadioController({ pollIntervalMs: 0, webSocketFactory: () => socket });
  await radio.connectHamlib('ws://127.0.0.1:8766/radio?token=abcdefghijklmnop');
  const clock = new Clock(), tx = new TransmitController(radio, { clock: () => clock.mono, wallClock: () => clock.utc, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  let audioStarts = 0;
  try {
    await tx.arm(request('USB')); await tx.scheduleOnce({ id: 'slow-key', startAtUtcMs: clock.utc + 2000, durationMs: 500, startAudio() { audioStarts++; }, stopAudio() {} });
    await clock.advance(1650); assert.ok(socket.pendingKey); assert.equal(tx.getState().status, 'pending');
    await clock.advance(275); assert.equal(tx.getState().armed, false); assert.equal(radio.getState().txStatus, 'rx');
    assert.match(tx.getState().error!, /key deadline/); assert.equal(socket.commands.some(command => command.op === 'release'), true);
    socket.respond(socket.pendingKey!.id, 'cat-tx'); await flush(); await clock.advance(1000);
    assert.equal(audioStarts, 0); assert.equal(radio.getState().txStatus, 'rx'); assert.equal(tx.getState().armed, false);
  } finally { await tx.dispose(); await radio.disconnect(); }
});

test('an old scheduled key completion cannot cancel a newer schedule deadline after rearming', async () => {
  const h = genericHardware(), completions: Array<() => void> = [];
  h.rig.setPtt = async () => { h.rig.keys++; await new Promise<void>(resolve => completions.push(resolve)); };
  let audioStarts = 0;
  const plan = () => ({ id: 'rearmed-key', startAtUtcMs: h.clock.utc + 2000, durationMs: 500, startAudio() { audioStarts++; }, stopAudio() {} });
  try {
    await h.tx.arm(request('USB')); await h.tx.scheduleOnce(plan()); await h.clock.advance(1650);
    await h.clock.advance(275); assert.equal(h.tx.getState().armed, false);
    await h.tx.arm(request('USB')); await h.tx.scheduleOnce(plan()); await h.clock.advance(1650);
    assert.equal(h.tx.getState().status, 'pending'); assert.equal(completions.length, 2);
    completions[0](); await flush();
    await h.clock.advance(275); assert.equal(h.tx.getState().armed, false); assert.match(h.tx.getState().error!, /key deadline/);
    completions[1](); await flush(); await h.clock.advance(1000);
    assert.equal(audioStarts, 0); assert.equal(h.rig.state.txStatus, 'rx');
  } finally { await h.tx.dispose(); }
});

test('generic non-FT891 driver arms from current readbacks and forwards the configured permit duration', async () => {
  const h = genericHardware();
  try {
    await h.tx.arm(request('USB', 20));
    assert.equal(h.rig.refreshes, 1);
    assert.equal(h.tx.getState().armed, true);
    assert.equal(h.tx.getState().simulated, false);
    assert.equal(h.rig.keys, 0, 'arming does not key a generic driver');
    await h.tx.holdPTT();
    assert.deepEqual(h.rig.permitDurations, [20]);
    assert.deepEqual(h.rig.permitKeyBoundaries, [undefined], 'manual holds do not carry a scheduled key boundary');
    assert.equal(h.tx.getState().status, 'transmitting');
    await h.tx.releasePTT();
    assert.equal(h.rig.state.txStatus, 'rx');
    assert.equal(h.tx.getState().rxConfirmed, true);
  } finally { await h.tx.dispose(); }
});

test('a fractional transmit lease is rejected before a generic bridge can be armed', async () => {
  const h = genericHardware();
  try { await assert.rejects(h.tx.arm(request('USB', 1.5)), /whole number between 1 and 30/); assert.equal(h.rig.refreshes, 0); assert.equal(h.rig.keys, 0); }
  finally { await h.tx.dispose(); }
});

test('generic drivers without PTT control or transmit readback cannot arm', async () => {
  for (const capability of ['ptt', 'pttReadback'] as const) {
    const h = genericHardware(); h.rig.capabilities[capability] = false;
    try { await assert.rejects(h.tx.arm(request('USB')), /PTT control and transmit-state readback/); assert.equal(h.rig.refreshes, 0); assert.equal(h.rig.keys, 0); }
    finally { await h.tx.dispose(); }
  }
});

test('generic arming rejects unknown transmit state, external transmit, and failed current readback', async () => {
  for (const state of [{ txStatus: 'unknown' }, { txStatus: 'external-tx', ptt: true }, { verified: false }, { connected: false }] as Array<Partial<RadioState>>) {
    const h = genericHardware(); Object.assign(h.rig.state, state);
    try { await assert.rejects(h.tx.arm(request('USB')), /receive|connected radio/); assert.equal(h.tx.getState().armed, false); assert.equal(h.rig.keys, 0); }
    finally { await h.tx.dispose(); }
  }
});

test('Hamlib USB digital scheduling uses advertised modes and preserves one-shot ordering', async () => {
  const h = genericHardware(), actions: Array<[string, number]> = [];
  const startAtUtcMs = h.clock.utc + 2000;
  try {
    await h.tx.arm(request('USB'));
    await h.tx.scheduleOnce({ id: 'generic-usb', startAtUtcMs, durationMs: 500, startAudio: () => { actions.push(['start', h.clock.mono]); }, stopAudio: () => { actions.push(['stop', h.clock.mono]); } });
    await h.clock.advance(1650); assert.equal(h.rig.keys, 1); assert.equal(actions.length, 0);
    assert.deepEqual(h.rig.permitKeyBoundaries, [startAtUtcMs - 75]);
    await h.clock.advance(350); assert.deepEqual(actions[0], ['start', 2000]);
    await h.clock.advance(650); assert.deepEqual(actions[1], ['stop', 2650]); assert.equal(h.rig.state.txStatus, 'rx'); assert.equal(h.tx.getState().armed, false);
    await h.clock.advance(20_000); assert.equal(h.rig.keys, 1);
  } finally { await h.tx.dispose(); }
});

test('generic scheduling rejects an unsupported audio mode before acquiring a transmit permit', async () => {
  const h = genericHardware(); h.rig.state.mode = 'LSB';
  try {
    await h.tx.arm(request('LSB'));
    await assert.rejects(h.tx.scheduleOnce({ id: 'unsupported', startAtUtcMs: h.clock.utc + 2000, durationMs: 100, startAudio() {}, stopAudio() {} }), /DATA-USB.*USB|USB.*DATA-USB/);
    assert.equal(h.rig.keys, 0); assert.deepEqual(h.rig.permitDurations, []);
  } finally { await h.tx.dispose(); }
});

test('generic model replacement or loss of PTT readback immediately revokes an existing arm', async () => {
  for (const change of ['model', 'pttReadback'] as const) {
    const h = genericHardware();
    try {
      await h.tx.arm(request('USB'));
      if (change === 'model') h.rig.state.model = 'Different rig'; else h.rig.capabilities.pttReadback = false;
      h.rig.emit(); await flush(); assert.equal(h.tx.getState().armed, false); assert.equal(h.rig.keys, 0);
    } finally { await h.tx.dispose(); }
  }
});

test('a Hamlib dummy driver derives simulation from capabilities and stays eligible for silent timing tests', async () => {
  const h = genericHardware(); h.rig.state.model = 'Dummy'; h.rig.state.verified = false; h.rig.capabilities.simulated = true;
  try { await h.tx.arm(request('USB')); assert.equal(h.tx.getState().simulated, true); assert.equal(h.rig.keys, 0); }
  finally { await h.tx.dispose(); }
});

test('split-aware generic arming requires simplex and split changes revoke an existing arm', async () => {
  const h = genericHardware(); Object.assign(h.rig.capabilities, { splitReadback: true });
  try {
    h.rig.state.split = true; await assert.rejects(h.tx.arm(request('USB')), /Confirm simplex/);
    h.rig.state.split = null; await assert.rejects(h.tx.arm(request('USB')), /Confirm simplex/);
    h.rig.state.split = false; await h.tx.arm(request('USB')); assert.equal(h.tx.getState().armed, true);
    h.rig.state.split = true; h.rig.emit(); await flush();
    assert.equal(h.tx.getState().armed, false); assert.equal(h.rig.keys, 0);
  } finally { await h.tx.dispose(); }
});

test('official FT-891 TX0/TX1/TX2 answers distinguish RX, CAT TX, and external TX', () => {
  assert.equal(parseFT891TransmitStatus('TX0;'), 'rx');
  assert.equal(parseFT891TransmitStatus('TX1;'), 'cat-tx');
  assert.equal(parseFT891TransmitStatus('TX2;'), 'external-tx');
  assert.throws(() => parseFT891TransmitStatus('TX3;'));
});

test('connect, discovery and transmit-controller creation never arm or key a radio', async () => {
  const h = await hardware();
  assert.equal(h.tx.getState().armed, false);
  assert.equal(h.radio.getCapabilities().ptt, true);
  await assert.rejects(h.tx.holdPTT(), /arming/);
  await assert.rejects(h.radio.setPtt(true, { kind: 'radiodesk-operator-transmit' } as RadioTransmitPermit), /permit/);
  assert.equal(h.port.commands.includes('TX1;'), false);
  await h.tx.dispose(); await h.radio.disconnect();
});

test('arm requires every explicit operator acknowledgement and matching state', async () => {
  const h = await hardware();
  for (const name of Object.keys(checklist) as Array<keyof typeof checklist>) await assert.rejects(h.tx.arm({ ...request(), acknowledgements: { ...checklist, [name]: false } }), /acknowledgement/);
  await assert.rejects(h.tx.arm({ ...request(), frequencyHz: 7_074_000 }), /must match/);
  await assert.rejects(h.tx.arm(request('USB')), /must match/);
  await assert.rejects(h.tx.arm(request('DATA-USB', 31)), /1 and 30/);
  await h.tx.arm(request());
  assert.equal(h.tx.getState().armed, true);
  assert.equal(Object.isFrozen(h.tx.getState()), true);
  assert.equal(h.port.commands.includes('TX1;'), false);
  await h.tx.dispose(); await h.radio.disconnect();
});

test('hardware manual PTT needs arm, reads TX1, releases TX0, and blocks tuning', async () => {
  const h = await hardware(); await h.tx.arm(request()); await h.tx.holdPTT();
  assert.equal(h.tx.getState().status, 'transmitting'); assert.equal(h.radio.getState().txStatus, 'cat-tx');
  await assert.rejects(h.radio.setFrequency(7_074_000), /Release PTT/);
  await assert.rejects(h.radio.setMode('USB'), /Release PTT/);
  await h.tx.releasePTT(); assert.equal(h.port.tx, '0'); assert.equal(h.tx.getState().rxConfirmed, true);
  assert.equal(h.tx.getState().status, 'armed');
  assert.equal(h.port.commands.includes('TX2;'), false);
  await h.tx.dispose(); await h.radio.disconnect();
});

test('dead-man maximum duration releases and disarms without a pointer-up event', async () => {
  const h = await hardware(); await h.tx.arm(request('DATA-USB', 1)); await h.tx.holdPTT();
  await h.clock.advance(1001); assert.equal(h.port.tx, '0'); assert.equal(h.tx.getState().armed, false);
  assert.equal(h.tx.getState().rxConfirmed, true); assert.match(h.tx.getState().error!, /duration|deadline/);
  await h.tx.dispose(); await h.radio.disconnect();
});

test('blur, hidden page, and pagehide release PTT and require explicit rearming', async () => {
  for (const event of ['blur', 'visibilitychange', 'pagehide']) {
    const h = await hardware(); await h.tx.arm(request()); await h.tx.holdPTT();
    if (event === 'visibilitychange') { h.documentTarget.hidden = true; h.documentTarget.dispatchEvent(new Event(event)); } else h.windowTarget.dispatchEvent(new Event(event));
    await flush(); assert.equal(h.port.tx, '0'); assert.equal(h.tx.getState().armed, false);
    await h.tx.dispose(); await h.radio.disconnect();
  }
});

for (const event of ['blur', 'visibilitychange', 'pagehide']) {
  test(`${event} during arm readback cancels the pending arm without keying`, async () => {
    const h = await hardware();
    const refresh = h.radio.refresh.bind(h.radio);
    const state = h.radio.getState();
    let complete!: () => void;
    h.radio.refresh = () => new Promise((resolve) => { complete = () => resolve(state); });
    const outcome = assert.rejects(h.tx.arm(request()), /Arming was canceled/);
    if (event === 'visibilitychange') {
      h.documentTarget.hidden = true;
      h.documentTarget.dispatchEvent(new Event(event));
    } else h.windowTarget.dispatchEvent(new Event(event));
    complete(); await outcome; await flush();
    assert.equal(h.tx.getState().armed, false);
    assert.equal(h.tx.getState().status, 'disarmed');
    assert.equal(h.clock.tasks.size, 0, 'a canceled readback must not install an armed watchdog');
    await assert.rejects(h.tx.holdPTT(), /arming/);
    assert.equal(h.port.commands.includes('TX1;'), false);

    // Returning to the page requires another explicit arm and another fresh readback.
    h.documentTarget.hidden = false; h.radio.refresh = refresh;
    await h.tx.arm(request());
    assert.equal(h.tx.getState().armed, true);
    assert.equal(h.port.commands.includes('TX1;'), false);
    await h.tx.dispose(); await h.radio.disconnect();
  });
}

test('a hidden page after arm readback rejects even without a visibility event', async () => {
  const h = await hardware();
  const refresh = h.radio.refresh.bind(h.radio);
  const state = h.radio.getState();
  let complete!: () => void;
  h.radio.refresh = () => new Promise((resolve) => { complete = () => resolve(state); });
  const outcome = assert.rejects(h.tx.arm(request()), /page became hidden/);
  h.documentTarget.hidden = true;
  complete(); await outcome;
  assert.equal(h.tx.getState().armed, false);
  assert.equal(h.clock.tasks.size, 0);
  assert.equal(h.port.commands.includes('TX1;'), false);
  h.radio.refresh = refresh;
  await h.tx.dispose(); await h.radio.disconnect();
});

test('a stale canceled arm completion cannot remove a newer pending arm cancellation guard', async () => {
  const h = await hardware();
  const state = h.radio.getState();
  const completions: Array<() => void> = [];
  h.radio.refresh = () => new Promise((resolve) => { completions.push(() => resolve(state)); });
  const first = assert.rejects(h.tx.arm(request()), /Arming was canceled/);
  h.windowTarget.dispatchEvent(new Event('blur'));
  const second = assert.rejects(h.tx.arm(request()), /Arming was canceled/);
  completions[0](); await first;
  h.windowTarget.dispatchEvent(new Event('pagehide'));
  completions[1](); await second;
  assert.equal(h.tx.getState().armed, false);
  assert.equal(h.clock.tasks.size, 0);
  assert.equal(h.port.commands.includes('TX1;'), false);
  await h.tx.dispose(); await h.radio.disconnect();
});

test('rejected CAT PTT does not claim transmit and attempts receive release', async () => {
  const h = await hardware(); await h.tx.arm(request()); h.port.refuseTx = true;
  await assert.rejects(h.tx.holdPTT(), /did not confirm/); await flush();
  assert.equal(h.port.tx, '0'); assert.equal(h.port.commands.includes('TX0;'), true); assert.equal(h.tx.getState().armed, false);
  await h.tx.dispose(); await h.radio.disconnect();
});

test('external physical PTT cannot be cleared or mislabeled as confirmed receive', async () => {
  const h = await hardware(); await h.tx.arm(request()); await h.tx.holdPTT(); h.port.tx = '2';
  await assert.rejects(h.tx.releasePTT(), /unconfirmed|did not confirm|release did not confirm/);
  assert.equal(h.port.tx, '2'); assert.equal(h.tx.getState().rxConfirmed, null); assert.equal(h.tx.getState().armed, false);
  await h.tx.dispose(); await h.radio.disconnect();
});

test('explicit emergency RX attempts TX0 on an unarmed external transmitter without claiming RX', async () => {
  const h = await hardware(); h.port.tx = '2'; await h.radio.refresh();
  assert.equal(h.tx.getState().armed, false); assert.equal(h.radio.getState().txStatus, 'external-tx');
  await assert.rejects(h.tx.emergencyStop(), /unconfirmed|release did not confirm/);
  assert.equal(h.port.commands.includes('TX0;'), true); assert.equal(h.port.commands.includes('TX2;'), false); assert.equal(h.port.tx, '2');
  assert.equal(h.tx.getState().rxConfirmed, null); assert.equal(h.tx.getState().status, 'fault');
  await h.tx.dispose(); await h.radio.disconnect();
});

test('serial readback timeout attempts TX0 and reports RX unconfirmed', async () => {
  const h = await hardware({ timeoutMs: 20 }); await h.tx.arm(request()); await h.tx.holdPTT(); h.port.ignoreTxRead = true;
  await assert.rejects(h.radio.readTransmitStatus(), /reply/); await flush();
  assert.equal(h.port.commands.includes('TX0;'), true); assert.equal(h.tx.getState().armed, false); assert.equal(h.tx.getState().rxConfirmed, null);
  await h.tx.dispose(); await h.radio.disconnect();
});

test('operator release while TX write is pending prevents a late acknowledgement from relatching', async () => {
  const h = await hardware(); await h.tx.arm(request());
  let unblock: (() => void) | undefined; h.port.delayTxWrite = () => new Promise<void>((resolve) => { unblock = resolve; });
  const holding = h.tx.holdPTT(); const outcome = holding.catch(() => undefined); await flush();
  const releasing = h.tx.releasePTT(); await flush(); unblock!(); await outcome; await releasing; await flush();
  assert.equal(h.port.tx, '0'); assert.equal(h.tx.getState().status, 'armed'); assert.equal(h.tx.getState().rxConfirmed, true);
  await h.tx.dispose(); await h.radio.disconnect();
});

test('disconnect during transmit attempts release and reconnect never restores arming', async () => {
  const h = await hardware(); await h.tx.arm(request()); await h.tx.holdPTT(); await h.radio.disconnect(); await flush();
  assert.equal(h.port.commands.includes('TX0;'), true); assert.equal(h.tx.getState().armed, false);
  await h.radio.connectSimulator(); assert.equal(h.tx.getState().armed, false); assert.equal(h.radio.getState().ptt, false);
  await h.tx.dispose(); await h.radio.disconnect();
});

test('radio tuning or mode changes while armed immediately revoke the arm', async () => {
  const radio = new RadioController({ pollIntervalMs: 0 }); await radio.connectSimulator();
  const clock = new Clock(); const tx = new TransmitController(radio, { clock: () => clock.mono, wallClock: () => clock.utc, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  await tx.arm(request('USB')); await radio.setFrequency(7_074_000); await flush();
  assert.equal(tx.getState().armed, false); await assert.rejects(tx.holdPTT(), /arming/);
  await tx.dispose(); await radio.disconnect();
});

test('physical dial changes between arming and keying are detected before any TX1 write', async () => {
  const h = await hardware(); await h.tx.arm(request()); h.port.frequency = 7_074_000;
  await assert.rejects(h.tx.holdPTT(), /physical radio after arming/);
  assert.equal(h.port.commands.includes('TX1;'), false); assert.equal(h.tx.getState().armed, false);
  await h.tx.dispose(); await h.radio.disconnect();
});

test('one scheduled digital send keys before the audio boundary and disarms after tail', async () => {
  const h = await hardware(); await h.tx.arm(request()); const actions: Array<[string, number]> = [];
  await h.tx.scheduleOnce({ id: 'slot', startAtUtcMs: h.clock.utc + 2000, durationMs: 1000, startAudio: () => { actions.push(['start', h.clock.mono]); }, stopAudio: () => { actions.push(['stop', h.clock.mono]); } });
  await h.clock.advance(1649); assert.equal(h.port.tx, '0');
  await h.clock.advance(1); assert.equal(h.port.tx, '1'); assert.equal(actions.length, 0);
  await h.clock.advance(350); assert.deepEqual(actions[0], ['start', 2000]);
  await h.clock.advance(1150); assert.equal(h.port.tx, '0'); assert.equal(h.tx.getState().armed, false); assert.deepEqual(actions[1], ['stop', 3150]);
  await h.clock.advance(20_000); assert.equal(h.port.commands.filter((command) => command === 'TX1;').length, 1);
  await h.tx.dispose(); await h.radio.disconnect();
});

test('scheduled duration includes CAT lead/tail and real digital mode must be DATA-USB', async () => {
  const h = await hardware(); await h.tx.arm(request('DATA-USB', 1));
  await assert.rejects(h.tx.scheduleOnce({ id: 'long', startAtUtcMs: h.clock.utc + 2000, durationMs: 800, startAudio() {}, stopAudio() {} }), /exceeds/);
  await h.tx.disarm(); h.port.mode = '2'; await h.radio.refresh(); await h.tx.arm(request('USB'));
  await assert.rejects(h.tx.scheduleOnce({ id: 'voice', startAtUtcMs: h.clock.utc + 2000, durationMs: 100, startAudio() {}, stopAudio() {} }), /DATA-USB/);
  await h.tx.dispose(); await h.radio.disconnect();
});

test('a UTC clock jump cancels a queued slot without sending TX1 or audio', async () => {
  const h = await hardware(); await h.tx.arm(request()); let audioStarts = 0;
  await h.tx.scheduleOnce({ id: 'clock-jump', startAtUtcMs: h.clock.utc + 2000, durationMs: 1000, startAudio: () => { audioStarts++; }, stopAudio() {} });
  h.clock.utc += 1000; await h.clock.advance(3000);
  assert.equal(h.port.commands.includes('TX1;'), false); assert.equal(audioStarts, 0); assert.equal(h.tx.getState().armed, false);
  await h.tx.dispose(); await h.radio.disconnect();
});

test('a late scheduled callback cancels instead of transmitting the missed slot', async () => {
  const h = await hardware(); await h.tx.arm(request()); let audioStarts = 0;
  await h.tx.scheduleOnce({ id: 'late', startAtUtcMs: h.clock.utc + 2000, durationMs: 1000, startAudio: () => { audioStarts++; }, stopAudio() {} });
  h.clock.mono += 2500; h.clock.utc += 2500;
  for (const item of [...h.clock.tasks.values()]) item.callback(); h.clock.tasks.clear(); await flush();
  assert.equal(h.port.commands.includes('TX1;'), false); assert.equal(audioStarts, 0); assert.equal(h.tx.getState().armed, false);
  await h.tx.dispose(); await h.radio.disconnect();
});

test('cancel after CAT keying prevents the later audio callback', async () => {
  const h = await hardware(); await h.tx.arm(request()); let starts = 0;
  await h.tx.scheduleOnce({ id: 'cancel', startAtUtcMs: h.clock.utc + 2000, durationMs: 1000, startAudio: () => { starts++; }, stopAudio() {} });
  await h.clock.advance(1700); await h.tx.releasePTT(); await h.clock.advance(4000);
  assert.equal(starts, 0); assert.equal(h.port.tx, '0'); await h.tx.dispose(); await h.radio.disconnect();
});

test('delayed audio startup is stopped again after cancellation rather than resurrected', async () => {
  const h = await hardware(); await h.tx.arm(request()); let finish: (() => void) | undefined, stops = 0;
  await h.tx.scheduleOnce({ id: 'deferred-audio', startAtUtcMs: h.clock.utc + 2000, durationMs: 1000, startAudio: () => new Promise<void>((resolve) => { finish = resolve; }), stopAudio: () => { stops++; } });
  await h.clock.advance(2000); await h.tx.emergencyStop(); finish!(); await flush();
  assert.equal(h.port.tx, '0'); assert.equal(stops, 2); await h.tx.dispose(); await h.radio.disconnect();
});

test('raw CAT transactions cannot forge a TX scope or send TX2', async () => {
  const commands: string[] = [];
  let receive: ((chunk: string) => void) | undefined;
  const transport: CATTransport = { write: async (command) => { commands.push(command); if (command === 'ID;') queueMicrotask(() => receive?.('ID0650;')); }, onData: (listener) => { receive = listener; return () => {}; }, onDisconnect: () => () => {}, close: async () => {} };
  const session = new CATSession(transport, 20);
  await assert.rejects(session.transact((access) => access.write('TX1;')), /scope/);
  await assert.rejects(session.transact((access) => access.write('TX1;'), { kind: 'operator-transmit-scope' } as CATTransmitScope), /scope/);
  assert.throws(() => session.grantTransmitScope(() => true), /recognized/);
  await session.transact((access) => access.query('ID;', (reply) => reply === 'ID0650;'));
  const permit = session.grantTransmitScope(() => true);
  await assert.rejects(session.transact((access) => access.write('TX2;'), permit), /blocked/);
  assert.deepEqual(commands, ['ID;']); await session.close();
});

test('priority emergency RX precedes a pending read and revokes a queued TX command', async () => {
  const commands: string[] = []; let receive: ((chunk: string) => void) | undefined;
  const transport: CATTransport = {
    write: async (command) => { commands.push(command); if (command === 'ID;') queueMicrotask(() => receive?.('ID0650;')); if (command === 'TX;') queueMicrotask(() => receive?.('TX0;')); },
    onData: (listener) => { receive = listener; return () => {}; }, onDisconnect: () => () => {}, close: async () => {},
  };
  const session = new CATSession(transport, 1000);
  await session.transact((access) => access.query('ID;', (reply) => reply === 'ID0650;'));
  const scope = session.grantTransmitScope(() => true);
  await session.transact((access) => access.write('TX1;'), scope);
  const pending = session.transact((access) => access.query('FA;', (reply) => reply.startsWith('FA')));
  const queued = session.transact((access) => access.write('TX1;'), scope); const rejected = assert.rejects(queued, /scope/);
  await flush(); const releasing = session.emergencyReceive(); await flush();
  assert.deepEqual(commands, ['ID;', 'TX1;', 'FA;', 'TX0;'], 'RX write did not wait for the unanswered FA query');
  receive!('FA014074000;'); await pending; await rejected; await releasing;
  assert.equal(commands.filter((command) => command === 'TX1;').length, 1); await session.close();
});

test('an expired TX scope is rechecked when queued work reaches the actual UART write', async () => {
  const commands: string[] = []; let receive: ((chunk: string) => void) | undefined, mono = 0;
  const transport: CATTransport = { write: async (command) => { commands.push(command); if (command === 'ID;') queueMicrotask(() => receive?.('ID0650;')); }, onData: (listener) => { receive = listener; return () => {}; }, onDisconnect: () => () => {}, close: async () => {} };
  const session = new CATSession(transport, 1000);
  await session.transact((access) => access.query('ID;', (reply) => reply === 'ID0650;'));
  const scope = session.grantTransmitScope(() => mono < 1000);
  const pending = session.transact((access) => access.query('FA;', (reply) => reply.startsWith('FA')));
  const queued = session.transact((access) => access.write('TX1;'), scope); const rejected = assert.rejects(queued, /scope/);
  await flush(); mono = 1500; receive!('FA014074000;'); await pending; await rejected;
  assert.deepEqual(commands, ['ID;', 'FA;']); await session.close();
});

test('wrong-model identity never grants CAT PTT capability', async () => {
  const port = new RigPort(); port.identity = '0670';
  const serial = new EventTarget() as SerialApiLike; serial.requestPort = async () => port; serial.getPorts = async () => [];
  const radio = new RadioController({ serial, pollIntervalMs: 0 });
  await assert.rejects(radio.connectSerial('ft891'), /not an FT-891/); assert.equal(radio.getCapabilities().ptt, false);
  assert.throws(() => radio.acquireTransmitPermit(() => true), /Connect/); assert.equal(port.commands.includes('TX1;'), false);
});
