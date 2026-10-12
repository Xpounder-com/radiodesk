import type { SerialPortLike } from './types.ts';

export interface CATTransport {
  write(command: string): Promise<void>;
  onData(listener: (chunk: string) => void): () => void;
  onDisconnect(listener: (reason: Error) => void): () => void;
  close(): Promise<void>;
}

/** Owns exactly the port explicitly selected by the operator. */
export class WebSerialTransport implements CATTransport {
  private port: SerialPortLike;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  private reading: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private dataListeners = new Set<(chunk: string) => void>();
  private disconnectListeners = new Set<(reason: Error) => void>();
  private disconnectHandler: EventListener;

  private constructor(port: SerialPortLike) {
    this.port = port;
    this.disconnectHandler = () => this.fail(new Error('The selected serial device was disconnected.'));
  }

  static async open(port: SerialPortLike, baudRate: number): Promise<WebSerialTransport> {
    const transport = new WebSerialTransport(port);
    await port.open({ baudRate, dataBits: 8, stopBits: 2, parity: 'none', flowControl: 'none' });
    try {
      // Never assert hardware PTT/keying lines. CAT RTS must be disabled on the radio.
      await port.setSignals({ dataTerminalReady: false, requestToSend: false, break: false });
      if (!port.readable || !port.writable) throw new Error('Selected serial port has no readable/writable streams.');
      transport.reader = port.readable.getReader();
      transport.writer = port.writable.getWriter();
      port.addEventListener('disconnect', transport.disconnectHandler);
      transport.reading = transport.readLoop();
      return transport;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async write(command: string): Promise<void> {
    if (this.closed || !this.writer) throw new Error('Serial transport is closed.');
    await this.writer.write(new TextEncoder().encode(command));
  }

  onData(listener: (chunk: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onDisconnect(listener: (reason: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      while (!this.closed && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) {
          if (!this.closed) this.fail(new Error('Serial input ended. Reconnect the selected CAT port.'));
          break;
        }
        const chunk = decoder.decode(value, { stream: true });
        for (const listener of this.dataListeners) listener(chunk);
      }
    } catch (error) {
      if (!this.closed) this.fail(error instanceof Error ? error : new Error('Serial read failed.'));
    }
  }

  private fail(reason: Error): void {
    if (this.closed) return;
    for (const listener of this.disconnectListeners) listener(reason);
    void this.close().catch(() => undefined);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.port.removeEventListener('disconnect', this.disconnectHandler);
    this.closing = (async () => {
      try {
        await this.reader?.cancel();
      } catch {
        // Physical removal can reject cancel; locks must still be released.
      }
      await this.reading;
      this.reader?.releaseLock();
      this.reader = undefined;
      try {
        await this.writer?.abort();
      } catch {
        // Unplugged output can reject abort; release the lock before closing.
      }
      this.writer?.releaseLock();
      this.writer = undefined;
      this.dataListeners.clear();
      this.disconnectListeners.clear();
      await this.port.close();
    })();
    return this.closing;
  }
}
