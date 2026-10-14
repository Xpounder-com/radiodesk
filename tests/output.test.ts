import test from 'node:test';
import assert from 'node:assert/strict';
import { TransmitAudioOutput, type RoutableAudioContext } from '../src/audio/output.ts';
import { bindTransmitHold, openArmDialog, updateTransmitUi } from '../src/ui/transmit.ts';
import type { TransmitController, TxState } from '../src/transmit/controller.ts';
import type { RadioController } from '../src/radio/controller.ts';

class MockSource {
  buffer: unknown;
  onended: (() => void) | null = null;
  starts = 0;
  stops = 0;
  disconnected = false;
  connect(): void {}
  start(): void { if (this.starts) throw new Error('Source already started'); this.starts++; }
  stop(): void { this.stops++; }
  disconnect(): void { this.disconnected = true; }
}

class MockGain {
  gain = { value: 1 };
  disconnected = false;
  connect(): void {}
  disconnect(): void { this.disconnected = true; }
}

class MockContext {
  state = 'suspended';
  destination = {};
  source = new MockSource();
  gain = new MockGain();
  closes = 0;
  resumes = 0;
  sink = '';
  copied: Float32Array | undefined;
  sinkDelay: (() => Promise<void>) | undefined;
  resumeDelay: (() => Promise<void>) | undefined;
  async setSinkId(id: string): Promise<void> { this.sink = id; await this.sinkDelay?.(); }
  async resume(): Promise<void> { this.resumes++; await this.resumeDelay?.(); if (this.state === 'closed') throw new Error('Audio context closed'); this.state = 'running'; }
  async close(): Promise<void> { this.closes++; this.state = 'closed'; }
  createBuffer(): { copyToChannel: (samples: Float32Array) => void } { return { copyToChannel: (samples) => { this.copied = samples.slice(); } }; }
  createBufferSource(): MockSource { return this.source; }
  createGain(): MockGain { return this.gain; }
}

const pcm = new Float32Array([0, 0.2, -0.2, 0]);
function output(context: MockContext): TransmitAudioOutput { return new TransmitAudioOutput({ createContext: () => context as unknown as RoutableAudioContext }); }
async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }

test('transmit preparation routes and copies PCM but produces no audio until explicit start', async () => {
  const context = new MockContext(), audio = output(context);
  await audio.prepare(pcm, 12000, 'radio-output');
  assert.equal(context.sink, 'radio-output'); assert.equal(context.source.starts, 0); assert.equal(audio.ready, true);
  assert.deepEqual(context.copied, pcm); audio.start(); assert.equal(context.source.starts, 1);
  assert.throws(() => audio.start(), /one-shot/); audio.stop();
  assert.equal(context.gain.gain.value, 0); assert.equal(context.source.disconnected, true); assert.equal(context.gain.disconnected, true); assert.equal(context.state, 'closed'); assert.equal(audio.ready, false);
});

test('silent simulator preparation never creates or resumes a physical audio context', async () => {
  let created = 0;
  const audio = new TransmitAudioOutput({ createContext: () => { created++; throw new Error('No physical context should be created'); } });
  await audio.prepare(pcm, 12000, '', false, true); assert.equal(audio.ready, true); audio.start(); assert.equal(created, 0);
  assert.throws(() => audio.start(), /one-shot/); audio.stop(); assert.equal(audio.ready, false);
});

test('a system-default output requires its separate explicit routing acknowledgement', async () => {
  const context = new MockContext(), audio = output(context);
  await assert.rejects(audio.prepare(pcm, 12000, ''), /explicitly confirm/); assert.equal(context.resumes, 0);
  await audio.prepare(pcm, 12000, '', true); assert.equal(context.source.starts, 0); audio.stop();
});

test('nonfinite, clipping and oversized PCM are rejected before any physical context is created', async () => {
  let created = 0; const audio = new TransmitAudioOutput({ createContext: () => { created++; return new MockContext() as unknown as RoutableAudioContext; } });
  for (const samples of [new Float32Array(), new Float32Array([NaN]), new Float32Array([Infinity]), new Float32Array([1.01])]) await assert.rejects(audio.prepare(samples, 12000, 'radio'), /Invalid|finite/);
  await assert.rejects(audio.prepare(new Float32Array(12000 * 31), 12000, 'radio'), /30-second/);
  await assert.rejects(audio.prepare(pcm, 7999, 'radio'), /Invalid/); assert.equal(created, 0);
});

test('stopping while output routing is pending immediately closes the owned context', async () => {
  const context = new MockContext(), audio = output(context); let routeReady: (() => void) | undefined;
  context.sinkDelay = () => new Promise<void>((resolve) => { routeReady = resolve; });
  const preparing = audio.prepare(pcm, 12000, 'radio-output'); const failed = assert.rejects(preparing, /canceled|closed/);
  audio.stop(); assert.equal(context.state, 'closed'); routeReady!(); await failed;
  assert.equal(context.resumes, 0); assert.equal(audio.ready, false); assert.equal(context.source.starts, 0);
});

test('stopping a pending context resume cannot resurrect the prepared source', async () => {
  const context = new MockContext(), audio = output(context); let resume: (() => void) | undefined;
  context.resumeDelay = () => new Promise<void>((resolve) => { resume = resolve; });
  const preparing = audio.prepare(pcm, 12000, 'radio-output'); const failed = assert.rejects(preparing, /canceled|closed/); await flush();
  audio.stop(); assert.equal(context.state, 'closed'); resume!(); await failed;
  assert.equal(audio.ready, false); assert.throws(() => audio.start(), /Prepare/); assert.equal(context.source.starts, 0);
});

test('an ended callback from a superseded audio source cannot stop the new output', async () => {
  const first = new MockContext(), second = new MockContext(); let next = 0;
  const audio = new TransmitAudioOutput({ createContext: () => [first, second][next++] as unknown as RoutableAudioContext });
  await audio.prepare(pcm, 12000, 'radio'); const oldEnded = first.source.onended!;
  await audio.prepare(pcm, 12000, 'radio'); oldEnded(); assert.equal(audio.ready, true); assert.equal(second.state, 'running');
  audio.start(); assert.equal(second.source.starts, 1); audio.stop();
});

test('a suspended or unsupported selected sink fails without starting audio', async () => {
  const unsupported = new MockContext(); Object.defineProperty(unsupported, 'setSinkId', { value: undefined });
  const noSink = output(unsupported); await assert.rejects(noSink.prepare(pcm, 12000, 'radio'), /cannot route/); assert.equal(unsupported.state, 'closed'); assert.equal(unsupported.source.starts, 0);
  const suspended = new MockContext(), audio = output(suspended); await audio.prepare(pcm, 12000, 'radio'); suspended.state = 'suspended';
  assert.throws(() => audio.start(), /suspended/); assert.equal(suspended.source.starts, 0); audio.stop(); audio.stop(); assert.equal(audio.ready, false);
});

class MockButton extends EventTarget {
  disabled = false;
  captured = new Set<number>();
  failCapture = false;
  setPointerCapture(pointer: number): void { if (this.failCapture) throw new Error('Capture unavailable'); this.captured.add(pointer); }
  hasPointerCapture(pointer: number): boolean { return this.captured.has(pointer); }
  releasePointerCapture(pointer: number): void { this.captured.delete(pointer); }
}

function event(type: string, properties: Record<string, unknown> = {}): Event {
  const result = new Event(type, { cancelable: true }); for (const [key, value] of Object.entries(properties)) Object.defineProperty(result, key, { value }); return result;
}

function globals(values: Record<string, unknown>): () => void {
  const originals = Object.fromEntries(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => { for (const [key, descriptor] of Object.entries(originals)) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); };
}

test('hold releases at window pointer-up when capture is unavailable and cleanup removes listeners', async () => {
  const button = new MockButton(); button.failCapture = true; const windowTarget = new EventTarget(); let holds = 0, releases = 0;
  const restore = globals({ document: { querySelector: () => button }, window: windowTarget });
  try {
    const binding = bindTransmitHold({ holdPTT: async () => { holds++; }, releasePTT: async () => { releases++; } } as unknown as TransmitController, () => {});
    button.dispatchEvent(event('pointerdown', { button: 0, pointerId: 7 })); windowTarget.dispatchEvent(event('pointerup', { pointerId: 7 })); await flush();
    assert.equal(holds, 1); assert.equal(releases, 1); binding(); button.dispatchEvent(event('pointerdown', { button: 0, pointerId: 8 })); assert.equal(holds, 1);
  } finally { restore(); }
});

test('keyboard hold ignores repeats and releases on focus loss or key-up outside the button', async () => {
  const button = new MockButton(), windowTarget = new EventTarget(); let holds = 0, releases = 0;
  const restore = globals({ document: { querySelector: () => button }, window: windowTarget });
  try {
    const binding = bindTransmitHold({ holdPTT: async () => { holds++; }, releasePTT: async () => { releases++; } } as unknown as TransmitController, () => {});
    button.dispatchEvent(event('keydown', { code: 'Space', repeat: false })); button.dispatchEvent(event('keydown', { code: 'Space', repeat: true }));
    windowTarget.dispatchEvent(event('keyup', { code: 'Space' })); button.dispatchEvent(event('keydown', { key: 'Enter', repeat: false })); button.dispatchEvent(event('blur')); await flush();
    assert.equal(holds, 2); assert.equal(releases, 2); binding();
  } finally { restore(); }
});

test('a late rejection of a prior hold cannot clear a newer hold or suppress its release', async () => {
  const button = new MockButton(), windowTarget = new EventTarget(); let holds = 0, releases = 0, oldReject: ((error: Error) => void) | undefined; const messages: string[] = [];
  const restore = globals({ document: { querySelector: () => button }, window: windowTarget });
  try {
    const binding = bindTransmitHold({ holdPTT: () => { holds++; return holds === 1 ? new Promise<void>((_, reject) => { oldReject = reject; }) : Promise.resolve(); }, releasePTT: async () => { releases++; } } as unknown as TransmitController, (message) => messages.push(message));
    button.dispatchEvent(event('pointerdown', { button: 0, pointerId: 1 })); button.dispatchEvent(event('pointerup', { pointerId: 1 }));
    button.dispatchEvent(event('pointerdown', { button: 0, pointerId: 2 })); oldReject!(new Error('Prior hold canceled')); await flush(); button.dispatchEvent(event('pointerup', { pointerId: 2 }));
    assert.equal(holds, 2); assert.equal(releases, 2); assert.deepEqual(messages, []); binding();
  } finally { restore(); }
});

class MockModal extends EventTarget {
  isConnected = true;
  ownerDocument = { body: {} };
  form = new EventTarget();
  submit = { disabled: false };
  fields: Record<string, unknown> = {
    '#tx-arm-form': this.form, '[type=submit]': this.submit,
    '#tx-output': { value: '' }, '#tx-default-route': { checked: true }, '#tx-operator': { value: 'N0CALL' }, '#tx-maximum': { value: '15' }, '#tx-arm-error': { textContent: '' },
  };
  querySelector(selector: string): unknown { return this.fields[selector]; }
}

test('programmatic arming-dialog removal cancels pending arm and late completion stays disarmed', async () => {
  const modal = new MockModal(); let observed: (() => void) | undefined, completeArm: (() => void) | undefined, armed = false, disarms = 0, closes = 0;
  class Observer { constructor(callback: () => void) { observed = callback; } observe(): void {} disconnect(): void {} }
  class FormDataMock { get(): string { return 'on'; } }
  const restore = globals({ MutationObserver: Observer, FormData: FormDataMock });
  try {
    const transmit = { getState: () => ({ armed }), arm: () => new Promise<void>((resolve) => { completeArm = () => { armed = true; resolve(); }; }), disarm: async () => { armed = false; disarms++; } } as unknown as TransmitController;
    await openArmDialog({ radio: { getState: () => ({ frequency: 14074000, mode: 'USB', driver: 'simulator' }), getCapabilities: () => ({ simulated: true, ptt: true, pttReadback: true }) } as unknown as RadioController, transmit, output: { stop() {} } as unknown as TransmitAudioOutput, settings: { call: 'N0CALL', grid: 'EN61', name: '', audioDevice: '', baudRate: 38400, step: 1000 }, dialog: () => modal as unknown as HTMLElement, close: () => { closes++; }, notify() {}, stopOtherAudio() {} });
    modal.form.dispatchEvent(event('submit')); assert.ok(completeArm); modal.isConnected = false; observed!(); assert.equal(disarms, 1);
    completeArm!(); await flush(); assert.equal(armed, false); assert.equal(disarms, 2); assert.equal(closes, 0);
  } finally { restore(); }
});

test('successful arming-dialog close does not cancel the newly completed explicit arm', async () => {
  const modal = new MockModal(); let observed: (() => void) | undefined, armed = false, disarms = 0;
  class Observer { constructor(callback: () => void) { observed = callback; } observe(): void {} disconnect(): void {} }
  class FormDataMock { get(): string { return 'on'; } }
  const restore = globals({ MutationObserver: Observer, FormData: FormDataMock });
  try {
    const transmit = { getState: () => ({ armed }), arm: async () => { armed = true; }, disarm: async () => { armed = false; disarms++; } } as unknown as TransmitController;
    await openArmDialog({ radio: { getState: () => ({ frequency: 14074000, mode: 'USB', driver: 'simulator' }), getCapabilities: () => ({ simulated: true, ptt: true, pttReadback: true }) } as unknown as RadioController, transmit, output: { stop() {} } as unknown as TransmitAudioOutput, settings: { call: 'N0CALL', grid: 'EN61', name: '', audioDevice: '', baudRate: 38400, step: 1000 }, dialog: () => modal as unknown as HTMLElement, close: () => { modal.isConnected = false; observed!(); }, notify() {}, stopOtherAudio() {} });
    modal.form.dispatchEvent(event('submit')); await flush(); assert.equal(armed, true); assert.equal(disarms, 0);
  } finally { restore(); }
});

class UiNode {
  id = '';
  textContent = '';
  innerHTML = '';
  className = '';
  disabled = false;
  classes = new Set<string>();
  classList = { toggle: (name: string, enabled: boolean) => { if (enabled) this.classes.add(name); else this.classes.delete(name); } };
  setAttribute(): void {}
  remove(): void {}
}

function uiFixture(): { nodes: Map<string, UiNode>; restore: () => void } {
  const nodes = new Map(['#tx-status', '#tx-detail', '#ptt-hold', '[data-action=arm-transmit]', '#receiver-rx', '.footer>span', '[data-action=disarm-transmit]'].map((name) => [name, new UiNode()]));
  const topbar = { insertAdjacentElement: (_position: string, node: UiNode) => { nodes.set(`#${node.id}`, node); node.remove = () => { nodes.delete(`#${node.id}`); }; } };
  const restore = globals({ document: { querySelector: (name: string) => name === '.topbar' ? topbar : nodes.get(name) ?? null, querySelectorAll: () => [], createElement: () => new UiNode() } });
  return { nodes, restore };
}

const initialTx: TxState = { armed: false, status: 'disarmed', operatorCall: '', frequencyHz: 0, mode: '', maximumSeconds: 10, rxConfirmed: null, scheduledAtUtcMs: null, source: null, elapsedMs: 0, simulated: false };

test('unarmed simulator UI is derived from the actual simulator rather than initial TX defaults', () => {
  const fixture = uiFixture();
  try {
    updateTransmitUi(initialTx, { getState: () => ({ connected: true, driver: 'simulator', ptt: false, txStatus: 'rx' }), getCapabilities: () => ({ simulated: true, ptt: true, pttReadback: true }) } as unknown as RadioController);
    assert.match(fixture.nodes.get('#tx-detail')!.textContent, /Simulator.*no physical audio/);
    assert.equal(fixture.nodes.get('#tx-detail')!.textContent.includes('Verify the physical radio'), false); assert.equal(fixture.nodes.has('#global-transmit'), false);
  } finally { fixture.restore(); }
});

test('a Hamlib dummy model stays visibly simulated before arming', () => {
  const fixture = uiFixture();
  try {
    updateTransmitUi(initialTx, { getState: () => ({ connected: true, driver: 'Hamlib', model: 'Dummy', identitySource: 'hamlib-configured', ptt: false, txStatus: 'rx' }), getCapabilities: () => ({ simulated: true, ptt: true, pttReadback: true }) } as unknown as RadioController);
    assert.match(fixture.nodes.get('#tx-detail')!.textContent, /Dummy.*Simulator.*no physical audio/);
    assert.match(fixture.nodes.get('.footer>span')!.innerHTML, /Dummy.*Hamlib/);
    assert.equal(fixture.nodes.has('#global-transmit'), false);
  } finally { fixture.restore(); }
});

test('receive-only Hamlib dummy disables operator arming and explains unavailable transmit control', () => {
  const fixture = uiFixture();
  try {
    updateTransmitUi(initialTx, { getState: () => ({ connected: true, verified: false, driver: 'Hamlib', model: 'Dummy', identitySource: 'hamlib-configured', ptt: false, txStatus: 'rx' }), getCapabilities: () => ({ simulated: true, ptt: false, pttReadback: true }) } as unknown as RadioController);
    assert.equal(fixture.nodes.get('[data-action=arm-transmit]')!.disabled, true);
    assert.match(fixture.nodes.get('#tx-detail')!.textContent, /transmit control is disabled.*no physical audio/);
    assert.equal(fixture.nodes.get('#tx-detail')!.textContent.includes('PTT and timing only'), false);
  } finally { fixture.restore(); }
});

test('arming button requires PTT/readback capability, current identity, receive and known simplex', () => {
  for (const variation of [{ state: { txStatus: 'unknown' } }, { state: { connected: false } }, { state: { verified: false } }, { state: { split: true }, capabilities: { splitReadback: true } }, { state: { split: null }, capabilities: { splitReadback: true } }, { capabilities: { pttReadback: false } }]) {
    const fixture = uiFixture();
    try {
      const actual = { connected: true, verified: true, driver: 'Hamlib', model: 'IC-7300', ptt: false, txStatus: 'rx', split: false, ...variation.state };
      const capabilities = { simulated: false, ptt: true, pttReadback: true, ...variation.capabilities };
      updateTransmitUi(initialTx, { getState: () => actual, getCapabilities: () => capabilities } as unknown as RadioController);
      assert.equal(fixture.nodes.get('[data-action=arm-transmit]')!.disabled, true);
    } finally { fixture.restore(); }
  }
  const fixture = uiFixture();
  try {
    updateTransmitUi(initialTx, { getState: () => ({ connected: true, verified: true, driver: 'Hamlib', model: 'IC-7300', ptt: false, txStatus: 'rx', split: false }), getCapabilities: () => ({ simulated: false, ptt: true, pttReadback: true, splitReadback: true }) } as unknown as RadioController);
    assert.equal(fixture.nodes.get('[data-action=arm-transmit]')!.disabled, false);
  } finally { fixture.restore(); }
});

test('generic physical transmit UI names the connected model and driver', () => {
  const fixture = uiFixture();
  try {
    updateTransmitUi(initialTx, { getState: () => ({ connected: true, driver: 'Hamlib', model: 'Icom IC-7300', identitySource: 'hamlib-configured', ptt: false, txStatus: 'rx' }), getCapabilities: () => ({ simulated: false, ptt: true, pttReadback: true }) } as unknown as RadioController);
    assert.match(fixture.nodes.get('#tx-detail')!.textContent, /Icom IC-7300.*Receive readback confirmed/);
    assert.match(fixture.nodes.get('.footer>span')!.innerHTML, /Icom IC-7300.*Hamlib/);
    assert.equal(fixture.nodes.get('#tx-detail')!.textContent.includes('FT-891'), false);
  } finally { fixture.restore(); }
});

test('generic arming dialog identifies the configured model and describes model-independent receive release', async () => {
  const modal = new MockModal(); let title = '', body = '';
  const transmit = { getState: () => ({ armed: false }), disarm: async () => {} } as unknown as TransmitController;
  await openArmDialog({ radio: { getState: () => ({ frequency: 14074000, mode: 'USB', driver: 'Hamlib', model: 'Icom IC-7300', identitySource: 'hamlib-configured' }), getCapabilities: () => ({ simulated: false, ptt: true, pttReadback: true }) } as unknown as RadioController, transmit, output: { stop() {} } as unknown as TransmitAudioOutput, settings: { call: 'N0CALL', grid: 'EN61', name: '', audioDevice: '', baudRate: 38400, step: 1000 }, dialog: (dialogTitle, dialogBody) => { title = dialogTitle; body = dialogBody; return modal as unknown as HTMLElement; }, close() {}, notify() {}, stopOtherAudio() {} });
  assert.equal(title, 'Arm Icom IC-7300 transmit');
  assert.match(body, /Model selected by the local Hamlib configuration/);
  assert.match(body, /Emergency RX requests receive through the connected driver/);
  assert.equal(body.includes('FT-891'), false);
  assert.equal(body.includes('attempts TX0'), false);
});

test('a configured radio model is escaped before entering an arming dialog title', async () => {
  const modal = new MockModal(); let title = '', body = '';
  const transmit = { getState: () => ({ armed: false }) } as unknown as TransmitController;
  await openArmDialog({ radio: { getState: () => ({ frequency: 14074000, mode: 'USB', driver: 'Hamlib', model: '<img src=x onerror=alert(1)>', identitySource: 'hamlib-configured' }), getCapabilities: () => ({ simulated: false, ptt: true, pttReadback: true }) } as unknown as RadioController, transmit, output: { stop() {} } as unknown as TransmitAudioOutput, settings: { call: 'N0CALL', grid: 'EN61', name: '', audioDevice: '', baudRate: 38400, step: 1000 }, dialog: (dialogTitle, dialogBody) => { title = dialogTitle; body = dialogBody; return modal as unknown as HTMLElement; }, close() {}, notify() {}, stopOtherAudio() {} });
  assert.match(title, /&lt;img/); assert.equal(title.includes('<img'), false); assert.equal(body.includes('<img'), false);
});

test('external transmit remains visible in the global banner even when operator arm is off', () => {
  const fixture = uiFixture();
  try {
    updateTransmitUi(initialTx, { getState: () => ({ connected: true, driver: 'Yaesu FT-891', ptt: true, txStatus: 'external-tx' }), getCapabilities: () => ({ simulated: false, ptt: true, pttReadback: true }) } as unknown as RadioController);
    assert.match(fixture.nodes.get('#tx-detail')!.textContent, /External radio-local transmit/);
    assert.match(fixture.nodes.get('#global-transmit')!.innerHTML, /EXTERNAL TX.*physical PTT/); assert.match(fixture.nodes.get('#receiver-rx')!.innerHTML, /EXTERNAL TX/);
  } finally { fixture.restore(); }
});

test('lost real-radio state does not turn a stale PTT boolean into confirmed TX or RX', () => {
  const fixture = uiFixture();
  try {
    updateTransmitUi({ ...initialTx, status: 'fault' }, { getState: () => ({ connected: false, driver: 'none', ptt: true, txStatus: 'unknown' }), getCapabilities: () => ({ simulated: false, ptt: true, pttReadback: true }) } as unknown as RadioController);
    assert.match(fixture.nodes.get('#global-transmit')!.innerHTML, /RX state unconfirmed/);
    assert.match(fixture.nodes.get('#receiver-rx')!.innerHTML, /STATE UNKNOWN/); assert.equal(fixture.nodes.get('#ptt-hold')!.classes.has('transmitting'), false);
    assert.equal(fixture.nodes.get('#global-transmit')!.innerHTML.includes('readback confirmed'), false);
  } finally { fixture.restore(); }
});
