import { canonicalDriverMode, copyCapabilities, validateDriverFrequency, type DriverTransmitPermit, type RadioCapabilities, type RadioDriver, type RadioHandshake, type RadioSnapshot, type TransmitStatus } from './driver.ts';

export interface HamlibSocket extends EventTarget {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type HamlibSocketFactory = (endpoint: string) => HamlibSocket;
export interface HamlibDriverOptions { socketFactory?: HamlibSocketFactory; timeoutMs?: number; }

const protocol = 'radiodesk-hamlib-v1';
const statusValues = ['rx', 'cat-tx', 'external-tx', 'unknown'];
const modePattern = /^[A-Z0-9][A-Z0-9-]{0,19}$/;
type Operation = 'hello' | 'read' | 'frequency' | 'mode' | 'ptt' | 'release' | 'heartbeat';
interface Pending { op: Operation; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; }

/** Validate without including a credential-bearing endpoint in an error. */
export function validateHamlibEndpoint(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('Use a valid Hamlib WebSocket endpoint.'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.pathname !== '/radio') throw new Error('Hamlib endpoint must use ws:// or wss://, the /radio path, and no credentials or fragment.');
  if (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Unencrypted Hamlib transport is restricted to loopback.');
  const token = url.searchParams.get('token');
  if (!token || token.length < 16 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token) || url.searchParams.getAll('token').length !== 1 || [...url.searchParams.keys()].some((key) => key !== 'token')) throw new Error('Hamlib endpoint needs exactly one valid bridge token.');
  return url.href;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed Hamlib bridge response.');
  return value as Record<string, unknown>;
}

export function validateHamlibCapabilities(value: unknown): RadioCapabilities {
  const input = record(value);
  for (const key of ['frequency', 'mode', 'ptt', 'pttReadback', 'receiveOnly', 'simulated']) if (typeof input[key] !== 'boolean') throw new Error('Malformed Hamlib capability flags.');
  const modes = input.modes, digitalModes = input.digitalModes;
  for (const key of ['hardwareReceiveOnly', 'splitReadback']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('Malformed Hamlib optional capability flags.');
  if (!Array.isArray(modes) || modes.length < 1 || modes.length > 64 || modes.some((mode) => typeof mode !== 'string' || !modePattern.test(mode)) || new Set(modes).size !== modes.length) throw new Error('Malformed Hamlib supported modes.');
  if (!Array.isArray(digitalModes) || digitalModes.some((mode) => typeof mode !== 'string' || !modes.includes(mode)) || new Set(digitalModes).size !== digitalModes.length) throw new Error('Malformed Hamlib digital modes.');
  if (!Number.isSafeInteger(input.minFrequency) || !Number.isSafeInteger(input.maxFrequency) || (input.minFrequency as number) <= 0 || (input.maxFrequency as number) < (input.minFrequency as number)) throw new Error('Malformed Hamlib frequency limits.');
  let frequencyRanges: RadioCapabilities['frequencyRanges'];
  if (input.frequencyRanges !== undefined) {
    if (!Array.isArray(input.frequencyRanges) || input.frequencyRanges.length > 64) throw new Error('Malformed Hamlib frequency ranges.');
    frequencyRanges = input.frequencyRanges.map((value) => {
      const range = record(value);
      if (!Number.isSafeInteger(range.min) || !Number.isSafeInteger(range.max) || (range.min as number) < (input.minFrequency as number) || (range.max as number) > (input.maxFrequency as number) || (range.max as number) < (range.min as number)) throw new Error('Malformed Hamlib frequency range.');
      return { min: range.min as number, max: range.max as number };
    });
    for (let i = 1; i < frequencyRanges.length; i++) if (frequencyRanges[i]!.min <= frequencyRanges[i - 1]!.max) throw new Error('Hamlib frequency ranges overlap or are unordered.');
    if (frequencyRanges.length && (frequencyRanges[0]!.min !== input.minFrequency || frequencyRanges.at(-1)!.max !== input.maxFrequency)) throw new Error('Hamlib frequency range limits disagree.');
    if (!frequencyRanges.length && input.frequency) throw new Error('Hamlib tuning needs a supported receive range.');
  }
  if (input.pttReadbackSource !== undefined && input.pttReadbackSource !== 'hamlib-backend') throw new Error('Malformed Hamlib PTT readback source.');
  if ((input.ptt && !input.pttReadback) || input.receiveOnly === input.ptt) throw new Error('Hamlib PTT requires truthful receive policy and TX readback.');
  if (input.ptt && (input.pttRouteVerified !== true || input.cacheTimeoutMs !== 0 || input.freshReadback !== true || typeof input.pttRoute !== 'string' || !['RIG', 'RIGMICDATA', ...(input.simulated ? ['None'] : [])].includes(input.pttRoute))) throw new Error('Hamlib PTT requires a verified CAT route and uncached fresh readbacks.');
  if (input.hardwareReceiveOnly && input.ptt) throw new Error('A hardware receiver cannot advertise PTT.');
  if (!input.pttReadback && !input.hardwareReceiveOnly && (input.frequency || input.mode)) throw new Error('Unconfirmed transceiver state cannot advertise safe tuning controls.');
  return { frequency: input.frequency as boolean, mode: input.mode as boolean, ptt: input.ptt as boolean, pttReadback: input.pttReadback as boolean, receiveOnly: input.receiveOnly as boolean, simulated: input.simulated as boolean, modes: [...modes] as string[], digitalModes: [...digitalModes] as string[], minFrequency: input.minFrequency as number, maxFrequency: input.maxFrequency as number, hardwareReceiveOnly: input.hardwareReceiveOnly === true, splitReadback: input.splitReadback === true, ...(frequencyRanges ? { frequencyRanges } : {}), ...(input.pttReadbackSource ? { pttReadbackSource: 'hamlib-backend' as const } : {}), ...(typeof input.pttRoute === 'string' || input.pttRoute === null ? { pttRoute: input.pttRoute } : {}), ...(typeof input.pttRouteVerified === 'boolean' ? { pttRouteVerified: input.pttRouteVerified } : {}), ...(typeof input.cacheTimeoutMs === 'number' && Number.isFinite(input.cacheTimeoutMs) || input.cacheTimeoutMs === null ? { cacheTimeoutMs: input.cacheTimeoutMs as number | null } : {}), ...(typeof input.freshReadback === 'boolean' ? { freshReadback: input.freshReadback } : {}) };
}

export function validateHamlibSnapshot(value: unknown, capabilities: RadioCapabilities): RadioSnapshot {
  const input = record(value);
  validateDriverFrequency(input.frequency as number, capabilities);
  if (typeof input.mode !== 'string' || !capabilities.modes.includes(input.mode)) throw new Error('Hamlib returned an unsupported mode.');
  if (typeof input.ptt !== 'boolean' || typeof input.txStatus !== 'string' || !statusValues.includes(input.txStatus)) throw new Error('Malformed Hamlib TX readback.');
  if ((input.txStatus === 'rx' && input.ptt) || (['cat-tx', 'external-tx'].includes(input.txStatus) && !input.ptt) || (!capabilities.pttReadback && input.txStatus !== 'unknown' && !(capabilities.hardwareReceiveOnly && input.txStatus === 'rx'))) throw new Error('Inconsistent Hamlib TX readback.');
  if (input.split !== undefined && input.split !== null && typeof input.split !== 'boolean') throw new Error('Malformed Hamlib split readback.');
  if (!capabilities.splitReadback && input.split !== undefined && input.split !== null) throw new Error('Hamlib split state requires readback capability.');
  return { frequency: input.frequency as number, mode: input.mode, ptt: input.ptt, txStatus: input.txStatus as TransmitStatus, split: capabilities.splitReadback ? (input.split === true ? true : input.split === false ? false : null) : null };
}

export function validateHamlibHello(value: unknown): RadioHandshake {
  const input = record(value);
  if (input.protocol !== protocol || input.identitySource !== 'hamlib-configured') throw new Error('Unsupported Hamlib bridge protocol or identity source.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120 || /[\x00-\x1f\x7f]/.test(input.name) || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 120 || /[\x00-\x1f\x7f]/.test(input.model)) throw new Error('Malformed Hamlib configured identity.');
  if (input.configuredModelName !== undefined && (typeof input.configuredModelName !== 'string' || !input.configuredModelName.trim() || input.configuredModelName.length > 120 || /[\x00-\x1f\x7f]/.test(input.configuredModelName))) throw new Error('Malformed Hamlib configured model name.');
  const capabilities = validateHamlibCapabilities(input.capabilities);
  // The bridge's built-in Dummy backend is the only simulated Hamlib target.
  if (capabilities.simulated && input.model !== '1') throw new Error('Only the known Hamlib Dummy backend may claim simulation.');
  const snapshot = validateHamlibSnapshot(input.snapshot, capabilities);
  if (capabilities.ptt && (!capabilities.splitReadback || snapshot.split !== false)) throw new Error('Hamlib PTT requires confirmed simplex readback.');
  return { identity: { id: 'hamlib', name: /^hamlib\b/i.test(input.name) ? input.name : `Hamlib · ${input.name}`, model: typeof input.configuredModelName === 'string' ? input.configuredModelName : input.name, source: 'hamlib-configured', backendId: input.model }, capabilities, snapshot };
}

/** JSON bridge driver. All permission and RF policy remains connection-bound. */
export class HamlibRadioDriver implements RadioDriver {
  private endpoint: string;
  private socketFactory: HamlibSocketFactory;
  private timeoutMs: number;
  private socket: HamlibSocket | undefined;
  private handshake: RadioHandshake | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private permits = new Map<DriverTransmitPermit, () => boolean>();
  private failures = new Set<(error: Error) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private closed = false;
  private mayHaveKeyed = false;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private openingReject: ((error: Error) => void) | undefined;
  private openingTimer: ReturnType<typeof setTimeout> | undefined;
  private closing: Promise<void> | undefined;

  constructor(endpoint: string, options: HamlibDriverOptions = {}) {
    this.endpoint = validateHamlibEndpoint(endpoint);
    this.timeoutMs = options.timeoutMs ?? 1800;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 30_000) throw new RangeError('Hamlib timeout must be 1–30000 ms.');
    this.socketFactory = options.socketFactory ?? ((url) => { if (typeof WebSocket === 'undefined') throw new Error('WebSocket transport is unavailable.'); return new WebSocket(url); });
  }

  async identify(): Promise<RadioHandshake> {
    if (this.closed || this.socket) throw new Error('Hamlib driver connection cannot be reused.');
    let socket: HamlibSocket;
    try { socket = this.socketFactory(this.endpoint); } catch { throw new Error('Unable to open the Hamlib bridge connection.'); }
    this.socket = socket;
    socket.addEventListener('message', this.onMessage);
    socket.addEventListener('close', this.onClose);
    socket.addEventListener('error', this.onError);
    try {
      await new Promise<void>((resolve, reject) => {
        this.openingReject = reject;
        this.openingTimer = setTimeout(() => this.fail(new Error('Hamlib bridge connection timed out.')), this.timeoutMs);
        socket.addEventListener('open', () => { if (this.closed) return; if (this.openingTimer) clearTimeout(this.openingTimer); this.openingTimer = undefined; this.openingReject = undefined; resolve(); }, { once: true });
        if (socket.readyState === 1) { if (this.openingTimer) clearTimeout(this.openingTimer); this.openingTimer = undefined; this.openingReject = undefined; resolve(); }
      });
      this.handshake = this.validate(await this.request('hello'), validateHamlibHello);
      this.startHeartbeat();
      return { ...this.handshake, capabilities: copyCapabilities(this.handshake.capabilities), snapshot: { ...this.handshake.snapshot }, identity: { ...this.handshake.identity } };
    } catch (error) { this.fail(error instanceof Error ? error : new Error('Hamlib connection failed.')); throw error; }
  }

  read(): Promise<RadioSnapshot> { return this.enqueue(() => this.readSnapshot()); }
  setFrequency(hz: number): Promise<RadioSnapshot> {
    this.requireIdentity(); const caps = this.handshake!.capabilities;
    if (!caps.frequency) return Promise.reject(new Error('This Hamlib backend does not support frequency changes.'));
    validateDriverFrequency(hz, caps);
    const epoch = this.epoch;
    return this.enqueue(async () => { this.requireReceive(await this.readSnapshot()); if (epoch !== this.epoch) throw new Error('Radio command canceled.'); return this.snapshot(await this.request('frequency', { value: hz })); });
  }
  setMode(mode: string): Promise<RadioSnapshot> {
    this.requireIdentity(); const caps = this.handshake!.capabilities;
    if (!caps.mode) return Promise.reject(new Error('This Hamlib backend does not support mode changes.'));
    const canonical = canonicalDriverMode(mode, caps), epoch = this.epoch;
    return this.enqueue(async () => { this.requireReceive(await this.readSnapshot()); if (epoch !== this.epoch) throw new Error('Radio command canceled.'); return this.snapshot(await this.request('mode', { value: canonical })); });
  }
  async readTransmitStatus(): Promise<TransmitStatus> { this.requireIdentity(); if (!this.handshake!.capabilities.pttReadback) throw new Error('This Hamlib backend has no TX-state readback.'); return (await this.read()).txStatus; }
  acquireTransmitPermit(current: () => boolean): DriverTransmitPermit { this.requireIdentity(); if (!this.handshake!.capabilities.ptt || !this.handshake!.capabilities.pttReadback) throw new Error('This Hamlib backend has no guarded PTT capability.'); const permit = Object.freeze({ kind: 'radiodesk-driver-permit' as const }); this.permits.set(permit, current); return permit; }
  revokeTransmitPermit(permit: DriverTransmitPermit): void { this.permits.delete(permit); }
  setPtt(active: boolean, permit: DriverTransmitPermit, expected: { frequency: number; mode: string }, maximumSeconds: number, keyBeforeUtcMs?: number): Promise<TransmitStatus> {
    this.requireIdentity();
    if (!Number.isInteger(maximumSeconds) || maximumSeconds < 1 || maximumSeconds > 30) return Promise.reject(new RangeError('PTT duration must be an integer from 1 to 30 seconds.'));
    if (keyBeforeUtcMs !== undefined && (!Number.isSafeInteger(keyBeforeUtcMs) || keyBeforeUtcMs <= 0)) return Promise.reject(new RangeError('Scheduled keying deadline must be a positive integer UTC timestamp.'));
    const epoch = this.epoch;
    return this.enqueue(async () => {
      const valid = () => epoch === this.epoch && this.permits.has(permit) && (!active || this.permits.get(permit)!());
      if (!valid()) throw new Error('PTT requires a current driver transmit permit.');
      if (!active) { await this.emergencyReceive(); return 'rx'; }
      if (keyBeforeUtcMs !== undefined && Date.now() >= keyBeforeUtcMs) throw new Error('Scheduled keying deadline was missed; no PTT request was sent.');
      const actual = await this.readSnapshot();
      this.requireReceive(actual);
      if (actual.split !== false) throw new Error('Confirm simplex before Hamlib PTT; split transmit is not supported.');
      if (actual.frequency !== expected.frequency || actual.mode !== expected.mode) throw new Error('Frequency or mode changed after arming.');
      if (!valid()) throw new Error('PTT request canceled before keying.');
      if (keyBeforeUtcMs !== undefined && Date.now() >= keyBeforeUtcMs) throw new Error('Scheduled keying deadline was missed; no PTT request was sent.');
      this.mayHaveKeyed = true;
      let reply: unknown;
      try { reply = await this.request('ptt', { active: true, expected: { ...expected }, maximumSeconds, ...(keyBeforeUtcMs !== undefined ? { keyBeforeUtcMs } : {}) }); }
      catch (error) { if (epoch !== this.epoch) return 'unknown'; throw error; }
      if (epoch !== this.epoch) return 'unknown';
      const result = this.txStatus(reply);
      if (result !== 'cat-tx') throw new Error('Hamlib did not confirm CAT transmit.');
      return result;
    });
  }
  async emergencyReceive(): Promise<void> {
    this.requireIdentity(); ++this.epoch; this.permits.clear();
    // Retire only issued key requests so a late acknowledgement cannot block rearming reads.
    for (const [id, pending] of this.pending) if (pending.op === 'ptt') { this.pending.delete(id); clearTimeout(pending.timer); pending.reject(new Error('Hamlib PTT request canceled by priority RX.')); }
    // Priority release bypasses the command queue; the bridge owns the independent watchdog.
    const result = this.txStatus(await this.request('release'));
    if (result !== 'rx') throw new Error('Hamlib release did not confirm receive. Use the independent radio failsafe.');
    this.mayHaveKeyed = false;
  }
  onFailure(listener: (reason: Error) => void): () => void { this.failures.add(listener); return () => this.failures.delete(listener); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    ++this.epoch; this.permits.clear(); this.clearHeartbeat();
    this.closing = (async () => { if (!this.closed && this.handshake && this.mayHaveKeyed) await this.emergencyReceive().catch(() => undefined); this.fail(new Error('Hamlib connection closed.'), false); })();
    return this.closing;
  }

  private requireIdentity(): void { if (this.closed || !this.handshake) throw new Error('Connect and identify the configured Hamlib backend first.'); }
  private requireReceive(snapshot: RadioSnapshot): void { if (snapshot.txStatus !== 'rx' || snapshot.ptt) throw new Error('Release PTT and confirm receive before changing radio state.'); }
  private enqueue<T>(work: () => Promise<T>): Promise<T> { const next = this.queue.then(() => { this.requireIdentity(); return work(); }); this.queue = next.catch(() => undefined); return next; }
  private async readSnapshot(): Promise<RadioSnapshot> { this.requireIdentity(); try { return this.snapshot(await this.request('read')); } catch (error) { const reason = error instanceof Error ? error : new Error('Hamlib state readback failed.'); this.fail(reason); throw reason; } }
  private snapshot(value: unknown): RadioSnapshot { return this.validate(value, (input) => validateHamlibSnapshot(input, this.handshake!.capabilities)); }
  private txStatus(value: unknown): TransmitStatus { return this.validate(value, (input) => { if (typeof input !== 'string' || !statusValues.includes(input)) throw new Error('Malformed Hamlib TX result.'); return input as TransmitStatus; }); }
  private validate<T>(value: unknown, parse: (input: unknown) => T): T { try { return parse(value); } catch { const error = new Error('Hamlib bridge returned invalid radio state or capabilities.'); this.fail(error); throw error; } }
  private request(op: Operation, fields: Record<string, unknown> = {}): Promise<unknown> {
    const socket = this.socket;
    if (this.closed || !socket || socket.readyState !== 1) return Promise.reject(new Error('Hamlib bridge is disconnected.'));
    if (socket.bufferedAmount > 16_384 || this.pending.size >= 16) { const error = new Error('Hamlib bridge control channel is congested.'); this.fail(error); return Promise.reject(error); }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Hamlib ${op} readback timed out. Receive is unconfirmed.`)), this.timeoutMs);
      this.pending.set(id, { op, resolve, reject, timer });
      try { socket.send(JSON.stringify({ id, op, ...fields })); } catch { this.fail(new Error('Hamlib bridge write failed. Receive is unconfirmed.')); }
    });
  }
  private onMessage: EventListener = (event) => {
    if (this.closed) return;
    try {
      const data = (event as MessageEvent).data;
      if (typeof data !== 'string' || data.length > 65_536) throw new Error();
      const reply = record(JSON.parse(data));
      if (!Number.isSafeInteger(reply.id) || (reply.id as number) <= 0 || typeof reply.ok !== 'boolean') throw new Error();
      const pending = this.pending.get(reply.id as number);
      if (!pending) return; // An old/duplicate reply cannot satisfy another request id.
      if (reply.ok && !Object.hasOwn(reply, 'result')) throw new Error();
      if (!reply.ok && typeof reply.error !== 'string') throw new Error();
      this.pending.delete(reply.id as number); clearTimeout(pending.timer);
      if (reply.ok) pending.resolve(reply.result);
      else pending.reject(new Error(`Hamlib bridge rejected the ${pending.op} request.`)); // Never reflect a token or backend command in UI errors.
    } catch { this.fail(new Error('Malformed Hamlib bridge message. Receive is unconfirmed.')); }
  };
  private onClose: EventListener = () => this.fail(new Error('Hamlib bridge disconnected. Receive is unconfirmed.'));
  private onError: EventListener = () => this.fail(new Error('Hamlib bridge connection failed. Receive is unconfirmed.'));
  private startHeartbeat(): void {
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      if (this.closed) return;
      void this.request('heartbeat').then((value) => { if (record(value).alive !== true) throw new Error(); if (!this.closed) this.startHeartbeat(); }).catch(() => this.fail(new Error('Hamlib heartbeat failed. Receive is unconfirmed.')));
    }, 1000);
  }
  private clearHeartbeat(): void { if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer); this.heartbeatTimer = undefined; }
  private fail(error: Error, notify = true): void {
    if (this.closed) return;
    this.closed = true; ++this.epoch; this.permits.clear(); this.clearHeartbeat();
    if (this.openingTimer) clearTimeout(this.openingTimer); this.openingTimer = undefined;
    this.openingReject?.(error); this.openingReject = undefined;
    const socket = this.socket;
    if (this.mayHaveKeyed && socket?.readyState === 1) { try { socket.send(JSON.stringify({ id: this.nextId++, op: 'release' })); } catch { /* The bridge watchdog independently handles lost sessions. */ } }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear();
    socket?.removeEventListener('message', this.onMessage); socket?.removeEventListener('close', this.onClose); socket?.removeEventListener('error', this.onError);
    try { socket?.close(1000, 'RadioDesk connection ended'); } catch { /* Already removed or unavailable. */ }
    if (notify) for (const listener of this.failures) listener(error);
  }
}
