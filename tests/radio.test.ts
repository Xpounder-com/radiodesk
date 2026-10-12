import test from 'node:test';
import assert from 'node:assert/strict';
import { RadioController } from '../src/radio/controller.ts';
import { CATSession } from '../src/radio/session.ts';
import { FT891Driver } from '../src/radio/ft891.ts';
import { CATFrameParser, assertReceiveOnlyCommand, encodeFT891Frequency, encodeFT891Mode, parseFT891Frequency, parseFT891Mode, validateFrequency } from '../src/radio/protocol.ts';
import { WebSerialTransport, type CATTransport } from '../src/devices/serial.ts';
import type { SerialPortLike, SerialApiLike } from '../src/devices/types.ts';

class MockTransport implements CATTransport {
  commands: string[] = [];
  closed = false;
  responders = new Map<string, string>();
  frequency = 14_074_000;
  mode = '2';
  bfo = '2';
  ptt = '0';
  identity = '0650';
  ignore = new Set<string>();
  data = new Set<(chunk: string) => void>();
  disconnected = new Set<(reason: Error) => void>();
  refuseFrequencyChange = false;

  async write(command: string): Promise<void> {
    if (this.closed) throw new Error('Mock closed');
    this.commands.push(command);
    if (this.ignore.has(command)) return;
    if (/^FA\d{9};$/.test(command)) {
      if (!this.refuseFrequencyChange) this.frequency = parseFT891Frequency(command);
      return;
    }
    if (/^MD0[1-9BCD];$/.test(command)) {
      this.mode = command[3]!;
      return;
    }
    const reply = this.responders.get(command) ?? ({
      'ID;': `ID${this.identity};`, 'FA;': encodeFT891Frequency(this.frequency), 'MD0;': `MD0${this.mode};`,
      'EX1107;': `EX1107${this.bfo};`, 'EX1011;': 'EX10111;', 'EX0812;': 'EX08120;', 'TX;': `TX${this.ptt};`,
    } as Record<string, string>)[command];
    if (reply) queueMicrotask(() => this.emit(reply));
  }

  emit(chunk: string): void { for (const listener of this.data) listener(chunk); }
  onData(listener: (chunk: string) => void): () => void { this.data.add(listener); return () => this.data.delete(listener); }
  onDisconnect(listener: (reason: Error) => void): () => void { this.disconnected.add(listener); return () => this.disconnected.delete(listener); }
  async close(): Promise<void> { this.closed = true; }
  unplug(): void { for (const listener of this.disconnected) listener(new Error('Unplugged')); }
}

class FakePort extends EventTarget implements SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  input: ReadableStreamDefaultController<Uint8Array> | undefined;
  commands: string[] = [];
  opened: unknown;
  signals: unknown;
  closed = false;
  frequency = 14_074_000;
  mode = '2';
  identity = '0650';
  ignore = new Set<string>();

  constructor() {
    super();
    this.readable = new ReadableStream({ start: (controller) => { this.input = controller; } });
    this.writable = new WritableStream({ write: (bytes) => {
      const command = new TextDecoder().decode(bytes);
      this.commands.push(command);
      if (this.ignore.has(command)) return;
      if (/^FA\d{9};$/.test(command)) { this.frequency = parseFT891Frequency(command); return; }
      if (/^MD0[1-9BCD];$/.test(command)) { this.mode = command[3]!; return; }
      const reply = ({ 'ID;': `ID${this.identity};`, 'FA;': encodeFT891Frequency(this.frequency), 'MD0;': `MD0${this.mode};`, 'EX1107;': 'EX11072;', 'TX;': 'TX0;' } as Record<string, string>)[command];
      if (reply) this.input!.enqueue(new TextEncoder().encode(reply));
    } });
  }
  async open(options: Parameters<SerialPortLike['open']>[0]): Promise<void> { this.opened = options; }
  async close(): Promise<void> { assert.equal(this.readable?.locked, false); assert.equal(this.writable?.locked, false); this.closed = true; }
  async setSignals(signals: Parameters<SerialPortLike['setSignals']>[0]): Promise<void> { this.signals = signals; }
  getInfo(): { usbVendorId: number; usbProductId: number } { return { usbVendorId: 0x10c4, usbProductId: 0xea70 }; }
}

function fakeSerial(port: FakePort): SerialApiLike & { requested: number } {
  const serial = new EventTarget() as SerialApiLike & { requested: number };
  serial.requested = 0;
  serial.requestPort = async () => { serial.requested++; return port; };
  serial.getPorts = async () => { throw new Error('Must not scan other ports.'); };
  return serial;
}

test('FT-891 frequency formatting and receive boundaries are exact', () => {
  assert.equal(encodeFT891Frequency(14_250_000), 'FA014250000;');
  assert.equal(encodeFT891Frequency(30_000), 'FA000030000;');
  assert.equal(parseFT891Frequency('FA056000000;'), 56_000_000);
  for (const invalid of [0, 29_999, 56_000_001, 14_074_000.1, NaN, Infinity]) assert.throws(() => validateFrequency(invalid), RangeError);
  assert.throws(() => parseFT891Frequency('FA14250000;'));
});

test('mode codec refuses an unknown mode or arbitrary CAT injection', () => {
  assert.equal(encodeFT891Mode('usb'), 'MD02;');
  assert.equal(parseFT891Mode('MD0B;'), 'FM-N');
  assert.equal(encodeFT891Mode('DATA-USB'), 'MD0C;');
  assert.throws(() => encodeFT891Mode('TX1;'));
  assert.throws(() => parseFT891Mode('MD0A;'));
});

test('frame parser handles fragmented, combined, and CRLF-separated replies', () => {
  const parser = new CATFrameParser();
  assert.deepEqual(parser.push('FA0142'), []);
  assert.deepEqual(parser.push('50000;\r\nMD02;TX'), ['FA014250000;', 'MD02;']);
  assert.deepEqual(parser.push('0;'), ['TX0;']);
  assert.throws(() => parser.push('x'.repeat(129)));
  assert.throws(() => new CATFrameParser().push('\u0000'));
});

test('receive-only allowlist blocks PTT, keying, tuner and menu writes', () => {
  for (const command of ['TX1;', 'TX0;', 'MX1;', 'KY CQ;', 'AC002;', 'VX1;', 'EX11070;', 'FA014250000;TX1;']) {
    assert.throws(() => assertReceiveOnlyCommand(command), /blocked/);
  }
  for (const command of ['ID;', 'FA;', 'MD0;', 'EX1107;', 'TX;', 'FA014250000;', 'MD02;']) assert.doesNotThrow(() => assertReceiveOnlyCommand(command));
});

test('FT-891 identity is required before any settings can change', async () => {
  const transport = new MockTransport();
  transport.identity = '0670';
  const session = new CATSession(transport);
  await assert.rejects(new FT891Driver(session).identify(), /not an FT-891/);
  assert.deepEqual(transport.commands, ['ID;']);
  await session.close();
});

test('initial readback includes BFO override and externally keyed TX status', async () => {
  const transport = new MockTransport();
  transport.bfo = '1';
  transport.ptt = '2';
  const session = new CATSession(transport);
  assert.deepEqual(await new FT891Driver(session).identify(), { frequency: 14_074_000, mode: 'LSB', ptt: true, txStatus: 'external-tx' });
  assert.deepEqual(transport.commands, ['ID;', 'FA;', 'MD0;', 'EX1107;', 'TX;']);
  await session.close();
});

test('setter state uses readback, even when the radio rejects an intended value', async () => {
  const transport = new MockTransport();
  transport.refuseFrequencyChange = true;
  const session = new CATSession(transport);
  const driver = new FT891Driver(session);
  await driver.identify();
  transport.commands.length = 0;
  const snapshot = await driver.setFrequency(7_074_000);
  assert.equal(snapshot.frequency, 14_074_000);
  assert.deepEqual(transport.commands.slice(0, 3), ['TX;', 'FA007074000;', 'FA;']);
  await session.close();
});

test('transactions serialize setter/readback sequences rather than interleave', async () => {
  const transport = new MockTransport();
  const session = new CATSession(transport);
  const driver = new FT891Driver(session);
  await driver.identify();
  transport.commands.length = 0;
  const [first, second] = await Promise.all([driver.setFrequency(7_074_000), driver.setFrequency(21_074_000)]);
  assert.equal(first.frequency, 7_074_000);
  assert.equal(second.frequency, 21_074_000);
  assert.deepEqual(transport.commands, ['TX;', 'FA007074000;', 'FA;', 'MD0;', 'EX1107;', 'TX;', 'TX;', 'FA021074000;', 'FA;', 'MD0;', 'EX1107;', 'TX;']);
  await session.close();
});

test('mode change rejects conflicting fixed BFO without writing a menu or mode', async () => {
  const transport = new MockTransport();
  transport.bfo = '1';
  const session = new CATSession(transport);
  const driver = new FT891Driver(session);
  await driver.identify();
  transport.commands.length = 0;
  await assert.rejects(driver.setMode('USB'), /BFO menu overrides/);
  assert.deepEqual(transport.commands, ['TX;', 'EX1107;']);
  await session.close();
});

test('DATA readback shows the real sideband selected by the radio menu', async () => {
  const transport = new MockTransport();
  transport.mode = '8';
  const session = new CATSession(transport);
  assert.equal((await new FT891Driver(session).identify()).mode, 'DATA-USB');
  await session.close();
});

test('driver setters cannot bypass the identity handshake', async () => {
  const transport = new MockTransport();
  const session = new CATSession(transport);
  const driver = new FT891Driver(session);
  assert.throws(() => driver.setFrequency(7_074_000), /Identify/);
  assert.throws(() => driver.setMode('USB'), /Identify/);
  assert.deepEqual(transport.commands, []);
  await session.close();
});

test('timeout closes transport and rejects queued work, protecting against stale replies', async () => {
  const transport = new MockTransport();
  transport.ignore.add('FA;');
  const session = new CATSession(transport, 15);
  const results = await Promise.allSettled([
    session.transact((commands) => commands.query('FA;', (reply) => reply.startsWith('FA'))),
    session.transact((commands) => commands.query('MD0;', (reply) => reply.startsWith('MD'))),
  ]);
  assert.equal(results[0]!.status, 'rejected');
  assert.equal(results[1]!.status, 'rejected');
  assert.equal(transport.closed, true);
  assert.deepEqual(transport.commands, ['FA;']);
  transport.emit('FA014250000;');
  await assert.rejects(session.transact((commands) => commands.query('FA;', () => true)), /No valid FA reply/);
});

test('a malformed or device error reply fails closed', async () => {
  const transport = new MockTransport();
  transport.responders.set('ID;', '?;');
  const session = new CATSession(transport, 20);
  await assert.rejects(new FT891Driver(session).identify(), /rejected a CAT command/);
  assert.equal(transport.closed, true);
});

test('physical disconnect rejects an active query immediately', async () => {
  const transport = new MockTransport();
  transport.ignore.add('FA;');
  const session = new CATSession(transport, 1000);
  const result = session.transact((commands) => commands.query('FA;', () => true));
  await Promise.resolve();
  transport.unplug();
  await assert.rejects(result, /Unplugged/);
  assert.equal(transport.closed, true);
});

test('a stalled serial writer times out instead of leaving a pending command forever', async () => {
  const transport = new MockTransport();
  transport.write = () => new Promise<void>(() => undefined);
  const session = new CATSession(transport, 15);
  await assert.rejects(session.transact((commands) => commands.query('ID;', () => true)), /reply|timed out/);
  assert.equal(transport.closed, true);
});

test('explicit simulator never claims verified hardware and exposes guarded simulated PTT', async () => {
  const controller = new RadioController();
  await assert.rejects(controller.setFrequency(7_074_000), /Connect a radio/);
  await controller.connectSimulator();
  await controller.setFrequency(7_074_000);
  await controller.setMode('LSB');
  assert.deepEqual(controller.getState(), { frequency: 7_074_000, mode: 'LSB', connected: true, driver: 'simulator', verified: false, ptt: false, txStatus: 'rx', error: undefined });
  assert.equal(controller.getCapabilities().ptt, true);
  assert.equal(controller.getCapabilities().simulated, true);
  await controller.disconnect();
  assert.equal(controller.getState().connected, false);
});

test('controller requests exactly one port and closes streams without retained locks', async () => {
  const port = new FakePort();
  const serial = fakeSerial(port);
  const controller = new RadioController({ serial, pollIntervalMs: 0 });
  const connecting = controller.connectSerial('ft891', 38400);
  assert.equal(serial.requested, 1, 'Chooser is invoked in the initiating gesture, before an await');
  await connecting;
  assert.equal(controller.getState().verified, true);
  assert.equal(controller.getState().frequency, 14_074_000);
  assert.deepEqual(port.signals, { dataTerminalReady: false, requestToSend: false, break: false });
  await controller.setFrequency(7_074_000);
  assert.equal(controller.getState().frequency, 7_074_000);
  await controller.disconnect();
  assert.equal(port.closed, true);
  assert.equal(controller.getState().verified, false);
  assert.equal(port.commands.some((command) => /^TX[012];$/.test(command)), false);
});

test('controller reports physical removal and marks the previous readback unverified', async () => {
  const port = new FakePort();
  const controller = new RadioController({ serial: fakeSerial(port), pollIntervalMs: 0 });
  await controller.connectSerial('ft891');
  port.dispatchEvent(new Event('disconnect'));
  assert.equal(controller.getState().connected, false);
  assert.equal(controller.getState().verified, false);
  assert.match(controller.getState().error!, /disconnected/);
  await controller.disconnect();
});

test('unsupported profile and baud never open the browser chooser', async () => {
  const serial = fakeSerial(new FakePort());
  const controller = new RadioController({ serial });
  await assert.rejects(controller.connectSerial('kenwood'), /model-specific/);
  await assert.rejects(controller.connectSerial('ft891', 115200), /CAT rate/);
  assert.equal(serial.requested, 0);
});

test('disconnect cancels an outstanding chooser without ever opening its eventual selection', async () => {
  const port = new FakePort();
  const serial = fakeSerial(port);
  let choose: ((selected: FakePort) => void) | undefined;
  serial.requestPort = () => new Promise<FakePort>((resolve) => { choose = resolve; });
  const controller = new RadioController({ serial, pollIntervalMs: 0 });
  const connecting = controller.connectSerial('ft891');
  const rejected = assert.rejects(connecting, /canceled/);
  await controller.disconnect();
  choose!(port);
  await rejected;
  assert.equal(port.opened, undefined);
  assert.equal(controller.getState().connected, false);
});

test('closing a Web Serial transport releases both stream locks', async () => {
  const port = new FakePort();
  const transport = await WebSerialTransport.open(port, 38400);
  assert.equal(port.readable!.locked, true);
  assert.equal(port.writable!.locked, true);
  await transport.close();
  assert.equal(port.closed, true);
});

test('simulator supports VHF band memories without claiming FT-891 hardware range',async()=>{const controller=new RadioController({pollIntervalMs:0});await controller.connectSimulator();await controller.setFrequency(144_200_000);assert.equal(controller.getState().frequency,144_200_000);assert.equal(controller.getState().verified,false);await assert.rejects(controller.setFrequency(2_000_000_000));await controller.disconnect();});
