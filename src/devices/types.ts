/** Browser interfaces kept local so the core does not depend on a Web Serial polyfill. */
export interface SerialPortLike extends EventTarget {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number; dataBits: 8; stopBits: 1 | 2; parity: 'none'; flowControl: 'none' }): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: { dataTerminalReady: boolean; requestToSend: boolean; break?: boolean }): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}

export interface SerialApiLike extends EventTarget {
  requestPort(options?: { filters?: Array<{ usbVendorId: number; usbProductId?: number }> }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

export interface DeviceDescriptor {
  id: string;
  label: string;
  kind: 'audioinput' | 'audiooutput' | 'serial';
  groupId?: string;
  permission: 'granted' | 'unknown';
  detail: string;
}

export interface BrowserCapability {
  id: string;
  label: string;
  supported: boolean;
  detail: string;
}

export function getSerialApi(): SerialApiLike | undefined {
  return typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { serial?: SerialApiLike }).serial;
}
