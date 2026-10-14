/** Model-independent state. Unknown TX is never a receive confirmation. */
export type TransmitStatus = 'rx' | 'cat-tx' | 'external-tx' | 'unknown';
export type RadioIdentitySource = 'none' | 'simulator' | 'protocol' | 'hamlib-configured';

export interface RadioSnapshot {
  frequency: number;
  mode: string;
  ptt: boolean;
  txStatus: TransmitStatus;
  split?: boolean | null;
}

export interface RadioCapabilities {
  frequency: boolean;
  mode: boolean;
  ptt: boolean;
  pttReadback: boolean;
  receiveOnly: boolean;
  simulated: boolean;
  modes: string[];
  minFrequency: number;
  maxFrequency: number;
  digitalModes: string[];
  /** Positive backend evidence that the hardware has no transmitter; not app RX policy. */
  hardwareReceiveOnly?: boolean;
  splitReadback?: boolean;
  frequencyRanges?: Array<{ min: number; max: number }>;
  pttReadbackSource?: 'hamlib-backend' | 'protocol' | 'simulation';
  pttRoute?: string | null;
  pttRouteVerified?: boolean;
  cacheTimeoutMs?: number | null;
  freshReadback?: boolean;
}

export interface RadioIdentity {
  id: string;
  name: string;
  model: string;
  source: Exclude<RadioIdentitySource, 'none'>;
  backendId?: string;
}

export interface RadioHandshake {
  identity: RadioIdentity;
  capabilities: RadioCapabilities;
  snapshot: RadioSnapshot;
}

/** Drivers accept only objects they issued, never structurally similar objects. */
export interface DriverTransmitPermit { readonly kind: 'radiodesk-driver-permit' }

/** One identified connection, its command policy, and its readback semantics. */
export interface RadioDriver {
  identify(): Promise<RadioHandshake>;
  read(): Promise<RadioSnapshot>;
  setFrequency(hz: number): Promise<RadioSnapshot>;
  setMode(mode: string): Promise<RadioSnapshot>;
  readTransmitStatus(): Promise<TransmitStatus>;
  acquireTransmitPermit(current: () => boolean): DriverTransmitPermit;
  revokeTransmitPermit(permit: DriverTransmitPermit): void;
  setPtt(active: boolean, permit: DriverTransmitPermit, expected: { frequency: number; mode: string }, maximumSeconds: number, keyBeforeUtcMs?: number): Promise<TransmitStatus>;
  emergencyReceive(): Promise<void>;
  onFailure(listener: (reason: Error) => void): () => void;
  close(): Promise<void>;
}

export function copyCapabilities(value: RadioCapabilities): RadioCapabilities {
  return { ...value, modes: [...value.modes], digitalModes: [...value.digitalModes], ...(value.frequencyRanges ? { frequencyRanges: value.frequencyRanges.map((range) => ({ ...range })) } : {}) };
}

export function validateDriverFrequency(hz: number, capabilities: RadioCapabilities): void {
  if (!Number.isSafeInteger(hz) || hz < capabilities.minFrequency || hz > capabilities.maxFrequency) throw new RangeError(`Frequency must be an integer from ${capabilities.minFrequency} to ${capabilities.maxFrequency} Hz for this driver.`);
  if (capabilities.frequencyRanges?.length && !capabilities.frequencyRanges.some((range) => hz >= range.min && hz <= range.max)) throw new RangeError('Frequency falls in a gap between the connected backend receive ranges.');
}

export function canonicalDriverMode(mode: string, capabilities: RadioCapabilities): string {
  const canonical = mode.toUpperCase();
  if (!capabilities.modes.includes(canonical)) throw new RangeError('Unsupported mode for the connected radio driver.');
  return canonical;
}
