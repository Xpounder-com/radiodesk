import { getSerialApi, type SerialApiLike, type SerialPortLike } from '../devices/types.ts';
import { WebSerialTransport } from '../devices/serial.ts';
import { CATSession, type CATTransmitScope } from './session.ts';
import { FT891Driver, type RadioSnapshot } from './ft891.ts';
import { FT891_BAUD_RATES, FT891_MIN_FREQUENCY, FT891_MAX_FREQUENCY, FT891_MODE_CODES, validateFrequency, encodeFT891Mode, type FT891TransmitStatus } from './protocol.ts';

export interface RadioState extends Omit<RadioSnapshot, 'txStatus'> {
  connected: boolean;
  driver: string;
  /** Fresh hardware identity and CAT state readback; this is not bench-test certification. */
  verified: boolean;
  error?: string;
  txStatus: FT891TransmitStatus | 'unknown';
}

export interface RadioTransmitPermit { readonly kind: 'radiodesk-operator-transmit' }

export interface RadioCapabilities {
  frequency: boolean;
  mode: boolean;
  ptt: boolean;
  receiveOnly: boolean;
  simulated: boolean;
  modes: string[];
  minFrequency: number;
  maxFrequency: number;
}

export interface RadioControllerOptions {
  serial?: SerialApiLike;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/** UI-independent state owner. Simulator and real hardware never share a connection. */
export class RadioController {
  private state: RadioState = { frequency: 14_074_000, mode: 'USB', ptt: false, txStatus: 'unknown', connected: false, driver: 'none', verified: false };
  private listeners = new Set<(state: RadioState) => void>();
  private serial: SerialApiLike | undefined;
  private pollIntervalMs: number;
  private timeoutMs: number;
  private session: CATSession | undefined;
  private driver: FT891Driver | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private connecting = false;
  private transmitRequested = false;
  private permits = new Map<RadioTransmitPermit, { generation: number; current: () => boolean; frequency: number; mode: string; scope?: CATTransmitScope }>();

  constructor(options: RadioControllerOptions = {}) {
    this.serial = options.serial;
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    this.timeoutMs = options.timeoutMs ?? 1800;
  }

  getState(): RadioState {
    return { ...this.state };
  }

  subscribe(listener: (state: RadioState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getCapabilities(): RadioCapabilities {
    return {
      frequency: this.state.connected,
      mode: this.state.connected,
      ptt: this.state.connected && (this.state.driver === 'simulator' || (this.state.driver === 'Yaesu FT-891' && this.state.verified)),
      receiveOnly: !this.state.connected,
      simulated: this.state.driver === 'simulator',
      modes: Object.keys(FT891_MODE_CODES),
      minFrequency: this.state.driver === 'simulator' ? 1_000 : FT891_MIN_FREQUENCY,
      maxFrequency: this.state.driver === 'simulator' ? 1_300_000_000 : FT891_MAX_FREQUENCY,
    };
  }

  async connectSimulator(): Promise<void> {
    await this.disconnect();
    this.update({ driver: 'simulator', connected: true, verified: false, ptt: false, txStatus: 'rx', error: undefined });
  }

  /** Call directly from a click handler so requestPort retains browser user activation. */
  async connectSerial(profile: 'ft891' | 'kenwood', baudRate = 38400, selectedPort?: SerialPortLike): Promise<void> {
    if (profile !== 'ft891') throw new Error('Choose the FT-891 driver. Kenwood requires a model-specific verified protocol and is not implemented.');
    if (!(FT891_BAUD_RATES as readonly number[]).includes(baudRate)) throw new RangeError('FT-891 CAT rate must be 4800, 9600, 19200, or 38400 baud.');
    if (this.connecting || this.state.connected) throw new Error('Disconnect the current station before selecting a hardware port.');
    const serial = this.serial ?? getSerialApi();
    if (!serial && !selectedPort) throw new Error('Web Serial is unavailable. Use a supporting browser on localhost or HTTPS.');
    this.connecting = true;
    const generation = ++this.generation;
    // No getPorts scan and no writes to unrelated devices. The chooser runs before any await.
    try {
      const selection = selectedPort ? Promise.resolve(selectedPort) : serial!.requestPort();
      const port = await selection;
      if (generation !== this.generation) throw new Error('Connection canceled.');
      const transport = await WebSerialTransport.open(port, baudRate);
      if (generation !== this.generation) {
        await transport.close();
        throw new Error('Connection canceled.');
      }
      const session = new CATSession(transport, this.timeoutMs);
      this.session = session;
      this.driver = new FT891Driver(session);
      session.onFailure((error) => {
        if (generation === this.generation) this.loseConnection(error);
      });
      const snapshot = await this.driver.identify();
      if (generation !== this.generation) throw new Error('Connection canceled.');
      this.update({ ...snapshot, driver: 'Yaesu FT-891', connected: true, verified: true, error: undefined });
      this.schedulePoll(generation);
    } catch (error) {
      if (generation === this.generation) {
        const reason = error instanceof Error ? error : new Error('Unable to open selected CAT port.');
        const session = this.session;
        this.session = undefined;
        this.driver = undefined;
        await session?.close().catch(() => undefined);
        this.update({ connected: false, verified: false, ptt: false, driver: 'none', error: reason.name === 'NotFoundError' ? 'Port selection canceled.' : reason.message });
      }
      throw error;
    } finally {
      if (generation === this.generation) this.connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    ++this.generation;
    this.connecting = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    const session = this.session;
    const release = this.transmitRequested || this.permits.size > 0 || this.state.txStatus === 'cat-tx';
    this.revokeAllTransmitPermits();
    this.transmitRequested = false;
    this.session = undefined;
    this.driver = undefined;
    this.update({ connected: false, verified: false, txStatus: 'unknown', driver: 'none', error: undefined });
    if (release && session) await session.emergencyReceive().catch(() => undefined);
    await session?.close();
  }

  async setFrequency(hz: number): Promise<void> {
    this.requireConnection();
    this.requireReceive();
    if (this.state.driver === 'simulator') {
      if(!Number.isSafeInteger(hz)||hz<1_000||hz>1_300_000_000)throw new RangeError('Simulator frequency must be an integer from 1 kHz to 1.3 GHz.');
      this.update({ frequency: hz });
      return;
    }
    validateFrequency(hz);
    const generation = this.generation;
    const snapshot = await this.driver!.setFrequency(hz);
    if (generation === this.generation) {
      this.update({ ...snapshot, verified: true });
      if (snapshot.frequency !== hz) throw new Error(`Radio readback is ${snapshot.frequency} Hz; the requested ${hz} Hz was not accepted.`);
    }
  }

  async setMode(mode: string): Promise<void> {
    const canonical = mode.toUpperCase();
    encodeFT891Mode(canonical);
    this.requireConnection();
    this.requireReceive();
    if (this.state.driver === 'simulator') {
      this.update({ mode: canonical });
      return;
    }
    const generation = this.generation;
    const snapshot = await this.driver!.setMode(canonical);
    if (generation === this.generation) this.update({ ...snapshot, verified: true });
  }

  private requireConnection(): void {
    if (!this.state.connected) throw new Error('Connect a radio or the explicit simulator first.');
  }

  private requireReceive(): void {
    if (this.transmitRequested || this.state.ptt) throw new Error('Release PTT and confirm receive before changing frequency or mode.');
  }

  /** SafetyCoordinator is the sole application caller; permits are opaque and connection-bound. */
  acquireTransmitPermit(current: () => boolean): RadioTransmitPermit {
    this.requireConnection();
    if (!this.getCapabilities().ptt) throw new Error('The connected receiver has no recognized PTT driver.');
    const permit = Object.freeze({ kind: 'radiodesk-operator-transmit' as const });
    const generation = this.generation;
    const valid = () => generation === this.generation && current();
    const scope = this.state.driver === 'simulator' ? undefined : this.session!.grantTransmitScope(valid);
    this.permits.set(permit, { generation, current: valid, frequency: this.state.frequency, mode: this.state.mode, scope });
    return permit;
  }

  revokeTransmitPermit(permit: RadioTransmitPermit): void {
    const existing = this.permits.get(permit);
    if (existing?.scope) this.session?.revokeTransmitScope(existing.scope);
    this.permits.delete(permit);
  }

  private revokeAllTransmitPermits(): void {
    for (const permit of this.permits.keys()) this.revokeTransmitPermit(permit);
  }

  async setPtt(active: boolean, permit: RadioTransmitPermit): Promise<void> {
    const authority = this.permits.get(permit);
    if (!authority || authority.generation !== this.generation || (active && !authority.current())) throw new Error('PTT requires a current operator transmit permit.');
    this.requireConnection();
    const generation = this.generation;
    if (active && (this.transmitRequested || this.state.ptt)) throw new Error('The radio is already transmitting or a PTT request is pending.');
    this.transmitRequested = active;
    if (this.state.driver === 'simulator') {
      this.update({ ptt: active, txStatus: active ? 'cat-tx' : 'rx' });
      return;
    }
    try {
      const txStatus = await this.driver!.setPtt(active, authority.scope!, { frequency: authority.frequency, mode: authority.mode });
      if (generation === this.generation && (!active || this.permits.has(permit))) this.update({ ptt: txStatus !== 'rx', txStatus });
    } catch (error) {
      if (generation === this.generation && (!active || this.permits.has(permit))) this.update({ txStatus: 'unknown' });
      throw error;
    }
  }

  async readTransmitStatus(): Promise<FT891TransmitStatus> {
    this.requireConnection();
    if (this.state.driver === 'simulator') return this.state.ptt ? 'cat-tx' : 'rx';
    const generation = this.generation;
    const txStatus = await this.driver!.readTransmitStatus();
    if (generation !== this.generation) throw new Error('Radio connection changed during transmit-status readback.');
    this.update({ ptt: txStatus !== 'rx', txStatus });
    return txStatus;
  }

  async emergencyReceive(): Promise<void> {
    this.revokeAllTransmitPermits();
    this.transmitRequested = false;
    if (!this.state.connected) throw new Error('Radio disconnected; receive cannot be confirmed. Use the independent radio failsafe.');
    if (this.state.driver === 'simulator') { this.update({ ptt: false, txStatus: 'rx' }); return; }
    const generation = this.generation;
    try {
      await this.session!.emergencyReceive();
      if (generation === this.generation) this.update({ ptt: false, txStatus: 'rx' });
    } catch (error) {
      if (generation === this.generation) this.update({ txStatus: 'unknown' });
      throw error;
    }
  }

  async refresh(): Promise<RadioState> {
    this.requireConnection();
    if (this.state.driver === 'simulator') return this.getState();
    const generation = this.generation;
    const snapshot = await this.driver!.read();
    if (generation !== this.generation) throw new Error('Radio connection changed during readback.');
    this.update({ ...snapshot, verified: true });
    return this.getState();
  }

  private schedulePoll(generation: number): void {
    if (this.pollIntervalMs <= 0) return;
    this.pollTimer = setTimeout(async () => {
      try {
        const snapshot = await this.driver?.read();
        if (snapshot && generation === this.generation) this.update({ ...snapshot, verified: true });
      } catch (error) {
        if (generation === this.generation) this.loseConnection(error instanceof Error ? error : new Error('CAT polling failed.'));
      }
      if (generation === this.generation && this.state.connected) this.schedulePoll(generation);
    }, this.pollIntervalMs);
  }

  private loseConnection(error: Error): void {
    ++this.generation;
    this.connecting = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    const session = this.session;
    this.revokeAllTransmitPermits();
    this.transmitRequested = false;
    this.session = undefined;
    this.driver = undefined;
    this.update({ connected: false, verified: false, txStatus: 'unknown', driver: 'none', error: `${error.message}${this.state.ptt ? ' Receive is unconfirmed; use the independent radio failsafe.' : ''}` });
    void session?.close().catch(() => undefined);
  }

  private update(patch: Partial<RadioState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.getState());
  }
}
