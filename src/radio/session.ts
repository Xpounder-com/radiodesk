import type { CATTransport } from '../devices/serial.ts';
import { assertReceiveOnlyCommand, assertScopedCATCommand, CATFrameParser } from './protocol.ts';

interface PendingReply {
  command: string;
  matches: (frame: string) => boolean;
  resolve: (frame: string) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CATCommands {
  write(command: string): Promise<void>;
  query(command: string, matches: (frame: string) => boolean): Promise<string>;
}

/** Opaque session-bound scope; structurally similar caller objects are not accepted. */
export interface CATTransmitScope { readonly kind: 'operator-transmit-scope' }

/** Whole transactions serialize, so a setter and its readback cannot interleave. */
export class CATSession {
  private transport: CATTransport;
  private timeoutMs: number;
  private parser = new CATFrameParser();
  private pending: PendingReply | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closedReason = new Error('CAT session closed.');
  private removeData: () => void;
  private removeDisconnect: () => void;
  private failureListeners = new Set<(error: Error) => void>();
  private closing: Promise<void> | undefined;
  private recognizedFT891 = false;
  private scopes = new Map<CATTransmitScope, () => boolean>();
  private mayHaveKeyed = false;

  constructor(transport: CATTransport, timeoutMs = 1800) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.removeData = transport.onData((chunk) => this.receive(chunk));
    this.removeDisconnect = transport.onDisconnect((reason) => this.fail(reason));
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  grantTransmitScope(isCurrent: () => boolean): CATTransmitScope {
    if (this.closed || !this.recognizedFT891) throw new Error('A live recognized FT-891 session is required for CAT PTT.');
    const scope = Object.freeze({ kind: 'operator-transmit-scope' as const });
    this.scopes.set(scope, isCurrent);
    return scope;
  }

  revokeTransmitScope(scope: CATTransmitScope): void { this.scopes.delete(scope); }
  confirmReceive(): void { this.mayHaveKeyed = false; }

  transact<T>(operation: (commands: CATCommands) => Promise<T>, scope?: CATTransmitScope): Promise<T> {
    const work = this.queue.then(async () => {
      if (this.closed) throw this.closedReason;
      return operation({ write: (command) => this.write(command, scope), query: (command, matches) => this.query(command, matches) });
    });
    this.queue = work.catch(() => undefined);
    return work;
  }

  private async write(command: string, scope?: CATTransmitScope): Promise<void> {
    if (this.closed) throw this.closedReason;
    const current = scope ? this.scopes.get(scope) : undefined;
    assertScopedCATCommand(command, !!current && (command === 'TX0;' || current()));
    if (command === 'TX1;') this.mayHaveKeyed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.transport.write(command),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Serial write timed out for ${command.slice(0, 2)}. Session closed; reconnect to avoid stale replies.`);
            this.fail(error);
            reject(error);
          }, this.timeoutMs);
        }),
      ]);
    } catch (error) {
      const reason = error instanceof Error ? error : new Error('CAT write failed.');
      this.fail(reason);
      throw reason;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private query(command: string, matches: (frame: string) => boolean): Promise<string> {
    if (this.closed) return Promise.reject(this.closedReason);
    assertReceiveOnlyCommand(command);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`No valid ${command.slice(0, 2)} reply within ${this.timeoutMs} ms. Check CAT port and baud rate, then reconnect.`)), this.timeoutMs);
      this.pending = { command, matches, resolve, reject, timer };
      void this.write(command).catch((error: unknown) => this.fail(error instanceof Error ? error : new Error('CAT write failed.')));
    });
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    try {
      for (const frame of this.parser.push(chunk)) {
        if (frame === '?;') {
          this.fail(new Error('The selected device rejected a CAT command.'));
          return;
        }
        if (this.pending?.matches(frame)) {
          const pending = this.pending;
          if (pending.command === 'ID;') this.recognizedFT891 = frame === 'ID0650;';
          this.pending = undefined;
          clearTimeout(pending.timer);
          pending.resolve(frame);
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Malformed CAT stream.'));
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closedReason = error;
    this.closed = true;
    this.scopes.clear();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    for (const listener of this.failureListeners) listener(error);
    void this.close().catch(() => undefined);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.scopes.clear();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.closedReason);
      this.pending = undefined;
    }
    this.removeData();
    this.removeDisconnect();
    this.failureListeners.clear();
    this.closing = (async () => {
      if (this.mayHaveKeyed && this.recognizedFT891) await this.bestEffortReceive();
      await this.transport.close();
    })();
    return this.closing;
  }

  /** Priority release bypasses queued work and invalidates every pending TX authorization. */
  async emergencyReceive(): Promise<void> {
    this.scopes.clear();
    if (!this.recognizedFT891) throw new Error('No identified FT-891 is available for an emergency RX command.');
    if (this.closed) {
      await this.bestEffortReceive();
      throw new Error('Serial session failed; emergency RX was attempted but cannot be confirmed. Use the independent radio failsafe.');
    }
    await this.writeEmergencyReceive();
    const frame = await this.transact((commands) => commands.query('TX;', (reply) => /^TX[012];$/.test(reply)));
    if (frame !== 'TX0;') throw new Error('CAT RX release did not confirm receive. Radio-local PTT/VOX/keying may remain active.');
    this.confirmReceive();
  }

  private async writeEmergencyReceive(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.transport.write('TX0;'), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Emergency RX write timed out; receive is unconfirmed.')), Math.min(this.timeoutMs, 500));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async bestEffortReceive(): Promise<void> {
    try { await this.writeEmergencyReceive(); } catch { /* Never label a failed/unconfirmed release as RX. */ }
  }
}
