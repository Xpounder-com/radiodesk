import { FT891Driver } from './ft891.ts';
import { CATSession, type CATTransmitScope } from './session.ts';
import { FT891_MIN_FREQUENCY, FT891_MAX_FREQUENCY, FT891_MODE_CODES } from './protocol.ts';
import { canonicalDriverMode, copyCapabilities, validateDriverFrequency, type RadioDriver, type RadioCapabilities, type RadioHandshake, type RadioSnapshot, type DriverTransmitPermit, type TransmitStatus } from './driver.ts';

export class FT891RadioDriver implements RadioDriver {
  private session: CATSession;
  private cat: FT891Driver;
  private permits = new Map<DriverTransmitPermit, CATTransmitScope>();
  constructor(session: CATSession) { this.session = session; this.cat = new FT891Driver(session); }
  async identify(): Promise<RadioHandshake> {
    const snapshot = await this.cat.identify();
    return { identity: { id: 'ft891', name: 'Yaesu FT-891', model: 'FT-891', source: 'protocol' }, capabilities: { frequency: true, mode: true, ptt: true, pttReadback: true, receiveOnly: false, simulated: false, modes: Object.keys(FT891_MODE_CODES), minFrequency: FT891_MIN_FREQUENCY, maxFrequency: FT891_MAX_FREQUENCY, digitalModes: ['DATA-USB'] }, snapshot };
  }
  read(): Promise<RadioSnapshot> { return this.cat.read(); }
  setFrequency(hz: number): Promise<RadioSnapshot> { return this.cat.setFrequency(hz); }
  setMode(mode: string): Promise<RadioSnapshot> { return this.cat.setMode(mode); }
  readTransmitStatus(): Promise<TransmitStatus> { return this.cat.readTransmitStatus(); }
  acquireTransmitPermit(current: () => boolean): DriverTransmitPermit {
    const permit = Object.freeze({ kind: 'radiodesk-driver-permit' as const });
    this.permits.set(permit, this.session.grantTransmitScope(current)); return permit;
  }
  revokeTransmitPermit(permit: DriverTransmitPermit): void { const scope = this.permits.get(permit); if (scope) this.session.revokeTransmitScope(scope); this.permits.delete(permit); }
  setPtt(active: boolean, permit: DriverTransmitPermit, expected: { frequency: number; mode: string }, _maximumSeconds: number, _keyBeforeUtcMs?: number): Promise<TransmitStatus> {
    const scope = this.permits.get(permit); if (!scope) return Promise.reject(new Error('PTT requires a current driver transmit permit.'));
    return this.cat.setPtt(active, scope, expected);
  }
  emergencyReceive(): Promise<void> { for (const permit of this.permits.keys()) this.revokeTransmitPermit(permit); return this.session.emergencyReceive(); }
  onFailure(listener: (reason: Error) => void): () => void { return this.session.onFailure(listener); }
  close(): Promise<void> { for (const permit of this.permits.keys()) this.revokeTransmitPermit(permit); return this.session.close(); }
}

const simulatorCapabilities: RadioCapabilities = { frequency: true, mode: true, ptt: true, pttReadback: true, receiveOnly: false, simulated: true, modes: ['USB', 'LSB', 'CW', 'CW-R', 'AM', 'AM-N', 'FM', 'FM-N', 'WFM', 'RTTY', 'RTTY-LSB', 'RTTY-USB', 'DATA', 'DATA-LSB', 'DATA-USB', 'DATA-FM'], minFrequency: 1_000, maxFrequency: 1_300_000_000, digitalModes: ['USB', 'DATA-USB'] };

export class SimulatorRadioDriver implements RadioDriver {
  private snapshot: RadioSnapshot;
  private closed = false;
  private permits = new Map<DriverTransmitPermit, () => boolean>();
  constructor(initial: Partial<RadioSnapshot> = {}) {
    this.snapshot = { frequency: Number.isSafeInteger(initial.frequency) && initial.frequency! >= simulatorCapabilities.minFrequency && initial.frequency! <= simulatorCapabilities.maxFrequency ? initial.frequency! : 14_074_000, mode: simulatorCapabilities.modes.includes(initial.mode ?? '') ? initial.mode! : 'USB', ptt: false, txStatus: 'rx' };
  }
  async identify(): Promise<RadioHandshake> { return { identity: { id: 'simulator', name: 'simulator', model: 'RadioDesk simulator', source: 'simulator' }, capabilities: copyCapabilities(simulatorCapabilities), snapshot: await this.read() }; }
  async read(): Promise<RadioSnapshot> { this.requireConnection(); return { ...this.snapshot }; }
  async setFrequency(hz: number): Promise<RadioSnapshot> { this.requireReceive(); validateDriverFrequency(hz, simulatorCapabilities); this.snapshot.frequency = hz; return this.read(); }
  async setMode(mode: string): Promise<RadioSnapshot> { this.requireReceive(); this.snapshot.mode = canonicalDriverMode(mode, simulatorCapabilities); return this.read(); }
  async readTransmitStatus(): Promise<TransmitStatus> { this.requireConnection(); return this.snapshot.txStatus; }
  acquireTransmitPermit(current: () => boolean): DriverTransmitPermit { this.requireConnection(); const permit = Object.freeze({ kind: 'radiodesk-driver-permit' as const }); this.permits.set(permit, current); return permit; }
  revokeTransmitPermit(permit: DriverTransmitPermit): void { this.permits.delete(permit); }
  async setPtt(active: boolean, permit: DriverTransmitPermit, expected: { frequency: number; mode: string }, _maximumSeconds: number, _keyBeforeUtcMs?: number): Promise<TransmitStatus> {
    this.requireConnection(); const current = this.permits.get(permit);
    if (!current || (active && !current())) throw new Error('PTT requires a current driver transmit permit.');
    if (active && (this.snapshot.txStatus !== 'rx' || this.snapshot.frequency !== expected.frequency || this.snapshot.mode !== expected.mode)) throw new Error('Simulator frequency, mode or receive state changed after arming.');
    this.snapshot = { ...this.snapshot, ptt: active, txStatus: active ? 'cat-tx' : 'rx' }; return this.snapshot.txStatus;
  }
  async emergencyReceive(): Promise<void> { this.requireConnection(); this.permits.clear(); this.snapshot = { ...this.snapshot, ptt: false, txStatus: 'rx' }; }
  onFailure(_listener: (reason: Error) => void): () => void { return () => {}; }
  async close(): Promise<void> { this.permits.clear(); this.closed = true; }
  private requireConnection(): void { if (this.closed) throw new Error('Simulator disconnected.'); }
  private requireReceive(): void { this.requireConnection(); if (this.snapshot.txStatus !== 'rx') throw new Error('Release PTT and confirm receive before changing frequency or mode.'); }
}
