import { getSerialApi, type SerialApiLike, type SerialPortLike } from '../devices/types.ts';
import { WebSerialTransport } from '../devices/serial.ts';
import { CATSession } from './session.ts';
import { FT891_BAUD_RATES } from './protocol.ts';
import { canonicalDriverMode, copyCapabilities, validateDriverFrequency, type DriverTransmitPermit, type RadioCapabilities, type RadioDriver, type RadioIdentitySource, type RadioSnapshot, type TransmitStatus } from './driver.ts';
import { createRadioDriver, getRadioDrivers, type RadioDriverDescriptor } from './registry.ts';
import { validateHamlibEndpoint, type HamlibSocketFactory } from './hamlib.ts';

export type { RadioCapabilities, RadioSnapshot, TransmitStatus } from './driver.ts';
export interface RadioState extends RadioSnapshot {
  connected: boolean;
  driver: string;
  model: string;
  backendId?: string;
  identitySource: RadioIdentitySource;
  /** Fresh identity/state readback, including configured Hamlib identity; never bench certification. */
  verified: boolean;
  error?: string;
}
export interface RadioTransmitPermit { readonly kind: 'radiodesk-operator-transmit' }
export interface RadioControllerOptions { serial?: SerialApiLike; pollIntervalMs?: number; timeoutMs?: number; webSocketFactory?: HamlibSocketFactory; }

const disconnectedCapabilities: RadioCapabilities = { frequency: false, mode: false, ptt: false, pttReadback: false, receiveOnly: true, simulated: false, modes: [], digitalModes: [], minFrequency: 0, maxFrequency: 0 };

/** State owner for a single explicit, registry-backed radio connection. */
export class RadioController {
  private state: RadioState = { frequency: 14_074_000, mode: 'USB', ptt: false, txStatus: 'unknown', connected: false, driver: 'none', model: '', identitySource: 'none', verified: false };
  private capabilities = copyCapabilities(disconnectedCapabilities);
  private listeners = new Set<(state: RadioState) => void>();
  private serial: SerialApiLike | undefined;
  private webSocketFactory: HamlibSocketFactory | undefined;
  private pollIntervalMs: number;
  private timeoutMs: number;
  private driver: RadioDriver | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private connecting = false;
  private transmitRequested = false;
  private permits = new Map<RadioTransmitPermit, { generation: number; current: () => boolean; frequency: number; mode: string; maximumSeconds: number; keyBeforeUtcMs?: number; driver: RadioDriver; scope: DriverTransmitPermit }>();

  constructor(options: RadioControllerOptions = {}) { this.serial = options.serial; this.webSocketFactory = options.webSocketFactory; this.pollIntervalMs = options.pollIntervalMs ?? 1500; this.timeoutMs = options.timeoutMs ?? 1800; }
  getState(): RadioState { return { ...this.state }; }
  subscribe(listener: (state: RadioState) => void): () => void { this.listeners.add(listener); listener(this.getState()); return () => this.listeners.delete(listener); }
  getDrivers(): readonly RadioDriverDescriptor[] { return getRadioDrivers(); }
  getCapabilities(): RadioCapabilities { const capabilities = copyCapabilities(this.capabilities); if (capabilities.splitReadback && this.state.split !== false) { capabilities.ptt = false; capabilities.receiveOnly = true; } return capabilities; }

  async connectSimulator(): Promise<void> {
    const generation = this.generation + 1;
    await this.disconnect();
    if (generation !== this.generation) throw new Error('Connection canceled.');
    this.connecting = true;
    const driver = createRadioDriver('simulator', { initial: this.state });
    try { await this.identify(driver, generation); } catch (error) { await this.connectionFailed(driver, generation, error); throw error; } finally { if (generation === this.generation) this.connecting = false; }
  }

  /** Invoke in a click handler: the chooser runs before any await. */
  async connectSerial(profile: 'ft891' | 'kenwood', baudRate = 38400, selectedPort?: SerialPortLike): Promise<void> {
    if (profile !== 'ft891') throw new Error('Choose the FT-891 driver. Kenwood requires a model-specific verified protocol and is not implemented.');
    if (!(FT891_BAUD_RATES as readonly number[]).includes(baudRate)) throw new RangeError('FT-891 CAT rate must be 4800, 9600, 19200, or 38400 baud.');
    this.requireDisconnected();
    const serial = this.serial ?? getSerialApi();
    if (!serial && !selectedPort) throw new Error('Web Serial is unavailable. Use a supporting browser on localhost or HTTPS.');
    this.connecting = true; const generation = ++this.generation;
    let driver: RadioDriver | undefined;
    try {
      const selection = selectedPort ? Promise.resolve(selectedPort) : serial!.requestPort();
      const port = await selection;
      if (generation !== this.generation) throw new Error('Connection canceled.');
      const transport = await WebSerialTransport.open(port, baudRate);
      if (generation !== this.generation) { await transport.close(); throw new Error('Connection canceled.'); }
      driver = createRadioDriver('ft891', { session: new CATSession(transport, this.timeoutMs) });
      await this.identify(driver, generation);
    } catch (error) { await this.connectionFailed(driver, generation, error); throw error; } finally { if (generation === this.generation) this.connecting = false; }
  }

  /** Operator supplies a token-bearing bridge URL; it is never persisted or reflected in errors. */
  async connectHamlib(endpoint: string): Promise<void> {
    this.requireDisconnected();
    const validated = validateHamlibEndpoint(endpoint);
    const driver = createRadioDriver('hamlib', { endpoint: validated, hamlib: { timeoutMs: this.timeoutMs, socketFactory: this.webSocketFactory } });
    this.connecting = true; const generation = ++this.generation;
    try { await this.identify(driver, generation); } catch (error) { await this.connectionFailed(driver, generation, error); throw error; } finally { if (generation === this.generation) this.connecting = false; }
  }

  async disconnect(): Promise<void> {
    ++this.generation; this.connecting = false;
    if (this.pollTimer) clearTimeout(this.pollTimer); this.pollTimer = undefined;
    const driver = this.driver;
    const release = this.transmitRequested || this.permits.size > 0 || this.state.txStatus === 'cat-tx';
    this.revokeAllTransmitPermits(); this.transmitRequested = false; this.driver = undefined;
    this.capabilities = copyCapabilities(disconnectedCapabilities);
    this.update({ connected: false, verified: false, txStatus: 'unknown', split: null, driver: 'none', model: '', backendId: undefined, identitySource: 'none', error: undefined });
    if (release && driver) await driver.emergencyReceive().catch(() => undefined);
    await driver?.close();
  }

  async setFrequency(hz: number): Promise<void> {
    this.requireConnection(); this.requireReceive();
    if (!this.capabilities.frequency) throw new Error('The connected driver does not support frequency changes.');
    validateDriverFrequency(hz, this.capabilities);
    const generation = this.generation, snapshot = await this.driver!.setFrequency(hz);
    if (generation !== this.generation) throw new Error('Radio connection changed during frequency readback.');
    this.updateSnapshot(snapshot);
    if (snapshot.frequency !== hz) throw new Error(`Radio readback is ${snapshot.frequency} Hz; the requested ${hz} Hz was not accepted.`);
  }
  async setMode(mode: string): Promise<void> {
    this.requireConnection(); this.requireReceive();
    if (!this.capabilities.mode) throw new Error('The connected driver does not support mode changes.');
    const canonical = canonicalDriverMode(mode, this.capabilities), generation = this.generation;
    const snapshot = await this.driver!.setMode(canonical);
    if (generation !== this.generation) throw new Error('Radio connection changed during mode readback.');
    this.updateSnapshot(snapshot);
  }

  /** Coordinator is the sole application caller; the driver also owns an opaque scope. */
  acquireTransmitPermit(current: () => boolean, maximumSeconds = 10, keyBeforeUtcMs?: number): RadioTransmitPermit {
    this.requireConnection();
    const capabilities = this.getCapabilities();
    if (!capabilities.ptt || !capabilities.pttReadback) throw new Error('The connected receiver has no guarded PTT readback capability.');
    if (!Number.isInteger(maximumSeconds) || maximumSeconds < 1 || maximumSeconds > 30) throw new RangeError('PTT duration must be an integer from 1 to 30 seconds.');
    if (keyBeforeUtcMs !== undefined && (!Number.isSafeInteger(keyBeforeUtcMs) || keyBeforeUtcMs <= 0)) throw new RangeError('Scheduled keying deadline must be a positive integer UTC timestamp.');
    const permit = Object.freeze({ kind: 'radiodesk-operator-transmit' as const }), generation = this.generation, driver = this.driver!;
    const valid = () => generation === this.generation && current() && (keyBeforeUtcMs === undefined || Date.now() < keyBeforeUtcMs);
    const scope = driver.acquireTransmitPermit(valid);
    this.permits.set(permit, { generation, current: valid, frequency: this.state.frequency, mode: this.state.mode, maximumSeconds, keyBeforeUtcMs, driver, scope }); return permit;
  }
  revokeTransmitPermit(permit: RadioTransmitPermit): void { const existing = this.permits.get(permit); if (existing) existing.driver.revokeTransmitPermit(existing.scope); this.permits.delete(permit); }
  private revokeAllTransmitPermits(): void { for (const permit of this.permits.keys()) this.revokeTransmitPermit(permit); }
  async setPtt(active: boolean, permit: RadioTransmitPermit): Promise<void> {
    const authority = this.permits.get(permit);
    if (!authority || authority.generation !== this.generation || (active && !authority.current())) throw new Error('PTT requires a current operator transmit permit.');
    this.requireConnection(); const generation = this.generation;
    if (active && (this.transmitRequested || this.state.ptt || this.state.txStatus !== 'rx')) throw new Error('The radio is already transmitting, unconfirmed, or a PTT request is pending.');
    this.transmitRequested = active;
    try {
      const txStatus = await authority.driver.setPtt(active, authority.scope, { frequency: authority.frequency, mode: authority.mode }, authority.maximumSeconds, authority.keyBeforeUtcMs);
      if (generation === this.generation && (!active || this.permits.has(permit))) this.update({ ptt: txStatus === 'rx' ? false : txStatus === 'unknown' ? this.state.ptt : true, txStatus });
    } catch (error) { if (generation === this.generation && (!active || this.permits.has(permit))) this.update({ txStatus: 'unknown' }); throw error; }
  }
  async readTransmitStatus(): Promise<TransmitStatus> {
    this.requireConnection(); const generation = this.generation;
    const txStatus = await this.driver!.readTransmitStatus();
    if (generation !== this.generation) throw new Error('Radio connection changed during transmit-status readback.');
    this.update({ ptt: txStatus === 'rx' ? false : txStatus === 'unknown' ? this.state.ptt : true, txStatus }); return txStatus;
  }
  async emergencyReceive(): Promise<void> {
    this.revokeAllTransmitPermits(); this.transmitRequested = false;
    if (!this.state.connected || !this.driver) throw new Error('Radio disconnected; receive cannot be confirmed. Use the independent radio failsafe.');
    const generation = this.generation;
    try { await this.driver.emergencyReceive(); if (generation !== this.generation) throw new Error('Radio connection changed during RX release.'); this.update({ ptt: false, txStatus: 'rx' }); }
    catch (error) { if (generation === this.generation) this.update({ txStatus: 'unknown' }); throw error; }
  }
  async refresh(): Promise<RadioState> {
    this.requireConnection(); const generation = this.generation, snapshot = await this.driver!.read();
    if (generation !== this.generation) throw new Error('Radio connection changed during readback.');
    this.updateSnapshot(snapshot); return this.getState();
  }

  private requireDisconnected(): void { if (this.connecting || this.state.connected) throw new Error('Disconnect the current station before selecting a hardware connection.'); }
  private requireConnection(): void { if (!this.state.connected || !this.driver) throw new Error('Connect a radio or the explicit simulator first.'); }
  private requireReceive(): void { if (this.transmitRequested || this.state.ptt || this.state.txStatus !== 'rx') throw new Error('Release PTT and confirm receive before changing frequency or mode.'); }
  private async identify(driver: RadioDriver, generation: number): Promise<void> {
    this.driver = driver;
    driver.onFailure((error) => { if (generation === this.generation) this.loseConnection(error); });
    const handshake = await driver.identify();
    if (generation !== this.generation) { await driver.close().catch(() => undefined); throw new Error('Connection canceled.'); }
    this.capabilities = copyCapabilities(handshake.capabilities);
    this.update({ ...handshake.snapshot, split: handshake.snapshot.split ?? null, driver: handshake.identity.name, model: handshake.identity.model, backendId: handshake.identity.backendId, identitySource: handshake.identity.source, connected: true, verified: !handshake.capabilities.simulated, error: undefined });
    this.schedulePoll(generation);
  }
  private async connectionFailed(driver: RadioDriver | undefined, generation: number, error: unknown): Promise<void> {
    await driver?.close().catch(() => undefined);
    if (generation !== this.generation) return;
    this.driver = undefined; this.capabilities = copyCapabilities(disconnectedCapabilities);
    const reason = error instanceof Error ? error : new Error('Unable to connect the selected radio.');
    this.update({ connected: false, verified: false, txStatus: 'unknown', split: null, driver: 'none', model: '', backendId: undefined, identitySource: 'none', error: reason.name === 'NotFoundError' ? 'Port selection canceled.' : reason.message });
  }
  private updateSnapshot(snapshot: RadioSnapshot): void { this.update({ ...snapshot, verified: !this.capabilities.simulated }); }
  private schedulePoll(generation: number): void {
    if (this.pollIntervalMs <= 0 || this.capabilities.simulated) return;
    this.pollTimer = setTimeout(async () => {
      try { const snapshot = await this.driver?.read(); if (snapshot && generation === this.generation) this.updateSnapshot(snapshot); }
      catch (error) { if (generation === this.generation) this.loseConnection(error instanceof Error ? error : new Error('Radio polling failed.')); }
      if (generation === this.generation && this.state.connected) this.schedulePoll(generation);
    }, this.pollIntervalMs);
  }
  private loseConnection(error: Error): void {
    ++this.generation; this.connecting = false;
    if (this.pollTimer) clearTimeout(this.pollTimer); this.pollTimer = undefined;
    const driver = this.driver; this.revokeAllTransmitPermits(); this.transmitRequested = false; this.driver = undefined;
    this.capabilities = copyCapabilities(disconnectedCapabilities);
    this.update({ connected: false, verified: false, txStatus: 'unknown', split: null, driver: 'none', model: '', backendId: undefined, identitySource: 'none', error: `${error.message}${this.state.ptt ? ' Receive is unconfirmed; use the independent radio failsafe.' : ''}` });
    void driver?.close().catch(() => undefined);
  }
  private update(patch: Partial<RadioState>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(this.getState()); }
}
