import test from 'node:test';
import assert from 'node:assert/strict';
import { SdrController } from '../src/sdr/controller.ts';

test('SDR controller sends real protocol controls and bounds queued IQ while muted audio remains available', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const oldWorker = globals.Worker, oldSocket = globals.WebSocket, oldSource = globals.__RADIO_DESK_SDR_WORKER__;
  const workers: FakeWorker[] = [], sockets: FakeSocket[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    messages: unknown[] = [];
    terminated = false;
    constructor(_url: string) { workers.push(this); }
    postMessage(data: unknown): void { this.messages.push(data); }
    terminate(): void { this.terminated = true; }
    emit(data: unknown): void { this.onmessage?.({ data } as MessageEvent); }
  }
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    binaryType = '';
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: (() => void) | null = null;
    messages: Uint8Array[] = [];
    constructor(_url: string) {
      sockets.push(this);
      queueMicrotask(() => {
        const header = new Uint8Array(12), view = new DataView(header.buffer); header.set([82, 84, 76, 48]); view.setUint32(4, 5); view.setUint32(8, 29);
        this.emit(header.buffer);
      });
    }
    send(bytes: Uint8Array): void { this.messages.push(bytes.slice()); }
    close(): void { this.readyState = 3; this.onclose?.(); }
    emit(data: ArrayBuffer): void { this.onmessage?.({ data } as MessageEvent); }
  }
  globals.Worker = FakeWorker; globals.WebSocket = FakeSocket; globals.__RADIO_DESK_SDR_WORKER__ = '/* fixture worker */';
  const controller = new SdrController();
  try {
    await controller.connect('ws://127.0.0.1:8765/iq?token=fixture', { sampleRate: 2048000, centerFrequency: 100000000 });
    assert.equal(controller.stats.header?.tunerName, 'R820T'); assert.equal(controller.stats.state, 'receiving');
    assert.deepEqual(sockets[0]!.messages.map(command => command[0]), [2, 1, 3]);
    assert.equal(new DataView(sockets[0]!.messages[1]!.buffer).getUint32(1), 100000000);
    assert.equal(controller.stats.controlStatus, 'requested without hardware readback');
    await new Promise(resolve => setTimeout(resolve, 120));
    for (let i = 0; i < 10; i++) sockets[0]!.emit(new Uint8Array(200).fill(128).buffer);
    assert.equal(controller.stats.pendingBlocks, 4); assert.equal(controller.stats.receivedSamples, 1000);
    assert.equal(controller.stats.droppedSamples, 600); assert.equal(controller.stats.droppedBlocks, 6);
    workers[0]!.emit({ type: 'ack' }); assert.equal(controller.stats.pendingBlocks, 3);
    let delivered = 0;
    const unsubscribe = controller.subscribeAudio(frame => { delivered++; assert.equal(frame.droppedSamples, 600); assert.equal(frame.frequencyHz, 100000000); assert.equal(frame.samples[0], 0.25); });
    workers[0]!.emit({ type: 'audio', samples: Float32Array.of(0.25), sampleRate: 48000, timestamp: 123, source: 'Fixture', configurationRevision: controller.stats.configurationRevision });
    assert.equal(delivered, 1); assert.equal(controller.stats.listening, false);
    unsubscribe();
    controller.setGain(-2.5); assert.deepEqual(sockets[0]!.messages.slice(-2).map(command => command[0]), [3, 4]);
    assert.equal(new DataView(sockets[0]!.messages.at(-1)!.buffer).getInt32(1), -25);
    controller.tune(144390000); assert.equal(controller.stats.centerFrequency, 144390000);
    assert.equal(new DataView(sockets[0]!.messages.at(-1)!.buffer).getUint32(1), 144390000);
    let staleDeliveries = 0; const removeStale = controller.subscribeAudio(() => { staleDeliveries++; });
    workers[0]!.emit({ type: 'audio', samples: Float32Array.of(0.5), sampleRate: 48000, timestamp: 124, source: 'Fixture', configurationRevision: controller.stats.configurationRevision - 1 });
    assert.equal(staleDeliveries, 0); removeStale();
    controller.disconnect(); assert.equal(controller.stats.state, 'stopped'); assert.equal(workers[0]!.terminated, true);
    await assert.rejects(controller.connect('ws://evil.example/iq', { sampleRate: 2048000, centerFrequency: 100000000 }), /restricted to loopback/);
  } finally {
    controller.disconnect();
    if (oldWorker === undefined) delete globals.Worker; else globals.Worker = oldWorker;
    if (oldSocket === undefined) delete globals.WebSocket; else globals.WebSocket = oldSocket;
    if (oldSource === undefined) delete globals.__RADIO_DESK_SDR_WORKER__; else globals.__RADIO_DESK_SDR_WORKER__ = oldSource;
  }
});
