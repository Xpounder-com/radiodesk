import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFtx, bindFtx } from '../src/ui/ftx.ts';
import { FtxSession, type FtxPacket } from '../src/operating/ftx-session.ts';
import type { TxState, TransmitController } from '../src/transmit/controller.ts';
import type { RadioController } from '../src/radio/controller.ts';
import type { TransmitAudioOutput } from '../src/audio/output.ts';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
class ElementMock {
  value = ''; checked = false; disabled = false; textContent = ''; innerHTML = ''; isConnected = true;
  private attributes = new Map<string, string>();
  private handlers = new Map<string, ((event: any) => void)[]>();
  nodes: Map<string, ElementMock>;
  constructor(nodes: Map<string, ElementMock>) { this.nodes = nodes; }
  querySelector(selector: string) { return this.nodes.get(selector.replace(/^#/, '')) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, listener: (event: any) => void) { const handlers = this.handlers.get(type) ?? []; handlers.push(listener); this.handlers.set(type, handlers); }
  click() { for (const handler of this.handlers.get('click') ?? []) handler({ target: this }); }
}

async function setup() {
  const settings = { call: 'K1ABC', grid: 'FN42', name: '', audioDevice: '', baudRate: 38400, step: 100 };
  const packet: FtxPacket = { message: 'CQ K1ABC FN42', mode: 'FT8', samples: new Float32Array(151680), sampleRate: 12000, tones: new Uint8Array(79), payload: new Uint8Array(10), wav: new ArrayBuffer(44), slotSeconds: 15, signalSeconds: 12.64, startDelaySeconds: 0.5 };
  const session = new FtxSession(async () => ({ encode: async () => packet, decode: async () => [], dispose() {} }));
  const nodes = new Map<string, ElementMock>();
  for (const match of renderFtx(settings, session.getState()).matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], new ElementMock(nodes));
  for (const [id, value] of Object.entries({ 'ftx-message': 'CQ K1ABC FN42', 'ftx-audio-hz': '1000', 'ftx-volume': '0.2', 'ftx-parity': 'next', 'ftx-mode': 'FT8', 'ftx-source': 'receiver' })) nodes.get(id)!.value = value;
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: (id: string) => nodes.get(id) ?? null, querySelector: (selector: string) => nodes.get(selector.replace(/^#/, '')) ?? null } });
  let state: TxState = { armed: true, status: 'armed', operatorCall: 'K1ABC', frequencyHz: 14074000, mode: 'DATA-USB', maximumSeconds: 15, rxConfirmed: true, scheduledAtUtcMs: null, source: null, elapsedMs: 0, simulated: true };
  const subscribers = new Set<(state: TxState) => void>(), scheduled: any[] = [], notes: string[] = [];
  const emit = () => { for (const listener of subscribers) listener(state); };
  const setArmed = (armed: boolean) => { state = { ...state, armed, status: armed ? 'armed' : 'disarmed', source: null }; emit(); };
  const transmit = {
    getState: () => ({ ...state }),
    subscribe: (listener: (state: TxState) => void) => { subscribers.add(listener); listener(state); return () => subscribers.delete(listener); },
    scheduleOnce: async (plan: any) => { scheduled.push(plan); state = { ...state, status: 'scheduled', source: 'scheduled', scheduledAtUtcMs: plan.startAtUtcMs }; emit(); },
    emergencyStop: async () => setArmed(false), disarm: async () => setArmed(false),
  } as unknown as TransmitController;
  const radioState = { connected: true, verified: false, frequency: 14074000, mode: 'DATA-USB', model: 'Icom IC-7300', driver: 'Hamlib', txStatus: 'rx' };
  const capabilities = { simulated: true, ptt: true, pttReadback: true, digitalModes: ['USB', 'DATA-USB'] };
  const radio = { getState: () => ({ ...radioState }), getCapabilities: () => ({ ...capabilities }) } as unknown as RadioController;
  const setMode = (mode: string) => { radioState.mode = mode; state = { ...state, mode }; emit(); };
  const setPtt = (enabled: boolean) => { capabilities.ptt = enabled; emit(); };
  const preparation = deferred(); let preparedCalls = 0, stopCalls = 0;
  const output = { prepare: async () => { preparedCalls++; await preparation.promise; }, stop: () => { stopCalls++; }, start: () => {} } as unknown as TransmitAudioOutput;
  const cleanupBinding = bindFtx({ session, radio, transmit, output, settings: () => settings, notify: message => notes.push(message), arm: async () => setArmed(true), isTransmitting: () => false });
  nodes.get('ftx-encode')!.click(); await settle();
  assert.equal(session.getState().prepared, packet);
  return { nodes, preparation, setArmed, setMode, setPtt, scheduled, notes, preparedCalls: () => preparedCalls, stopCalls: () => stopCalls, cleanupBinding,
    cleanup: async () => { cleanupBinding(); await session.dispose(); if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document'); } };
}

test('revoking an arm during asyncaudio preparation cancels the old send even after identical rearming', async () => {
  const fixture = await setup();
  try {
    fixture.nodes.get('ftx-send')!.click(); await settle(); assert.equal(fixture.preparedCalls(), 1);
    fixture.setArmed(false); fixture.setArmed(true); fixture.preparation.resolve(); await settle();
    assert.equal(fixture.scheduled.length, 0, 'A new arm must not resurrect the send requested under the revoked arm.');
    assert.ok(fixture.stopCalls() >= 1); assert.ok(!fixture.notes.some(note => note.includes('send scheduled')));
    fixture.nodes.get('ftx-send')!.click(); await settle();
    assert.equal(fixture.scheduled.length, 1, 'A fresh explicit send is permitted under the new arm.');
    assert.equal(fixture.scheduled[0].durationMs, 12640, 'Scheduling uses active PCM, excluding UTC slot padding.');
  } finally { await fixture.cleanup(); }
});

test('FT8 send rejects an unsupported driver audio mode before preparing any output', async () => {
  const fixture = await setup();
  try {
    fixture.setMode('LSB');
    assert.equal(fixture.nodes.get('ftx-send')!.disabled, true);
    assert.match(fixture.nodes.get('ftx-transmit-detail')!.textContent, /Icom IC-7300.*LSB.*unavailable.*USB/);
    fixture.nodes.get('ftx-send')!.click(); await settle();
    assert.equal(fixture.preparedCalls(), 0); assert.equal(fixture.scheduled.length, 0);
    assert.ok(fixture.notes.some(note => note.includes('audio mode supported')));
    fixture.setMode('USB'); assert.equal(fixture.nodes.get('ftx-send')!.disabled, false);
  } finally { await fixture.cleanup(); }
});

test('FT8 receive-only driver disables Arm and Send and retains waveform tools', async () => {
  const fixture = await setup();
  try {
    fixture.setPtt(false);
    assert.equal(fixture.nodes.get('ftx-arm')!.disabled, true);
    assert.equal(fixture.nodes.get('ftx-send')!.disabled, true);
    assert.equal(fixture.nodes.get('ftx-download')!.disabled, false);
    assert.match(fixture.nodes.get('ftx-transmit-detail')!.textContent, /Transmit unavailable.*Receive decoding and waveform exports remain available/);
    fixture.nodes.get('ftx-send')!.click(); await settle(); assert.equal(fixture.preparedCalls(), 0); assert.equal(fixture.scheduled.length, 0);
  } finally { await fixture.cleanup(); }
});

test('closing the FT8view while audio outputprepares prevents late scheduling', async () => {
  const fixture = await setup();
  try {
    fixture.nodes.get('ftx-send')!.click(); await settle(); fixture.cleanupBinding();
    fixture.preparation.resolve(); await settle(); assert.equal(fixture.scheduled.length, 0); assert.ok(fixture.stopCalls() >= 1);
  } finally { await fixture.cleanup(); }
});
