import { PcmResampler } from './resample.ts';
import { UtcSlotCollector, type FtxMode } from './slots.ts';
export type { FtxMode } from './slots.ts';
export interface FtxPacket { message: string; mode: FtxMode; samples: Float32Array; sampleRate: number; tones: Uint8Array; payload: Uint8Array; wav: ArrayBuffer; slotSeconds: number; signalSeconds: number; startDelaySeconds: number }
export interface FtxDecoded { text: string; audioHz: number; timeOffsetSeconds: number; syncScore: number; mode: FtxMode }
export interface FtxModem {
  encode(message: string, mode: FtxMode, options?: { audioHz?: number; sampleRate?: 12000 | 24000 | 48000; volume?: number; freeText?: boolean }): Promise<FtxPacket>;
  decode(samples: Float32Array, sampleRate: number, mode: FtxMode): Promise<FtxDecoded[]>;
  dispose(): void;
}
export interface FtxMessage extends FtxDecoded { id: string; utc: string; source: string }
export interface FtxSessionState { mode: FtxMode; receiving: boolean; source: 'receiver' | 'sdr'; busy: boolean; coverage: number; skipped: number; error: string; status: string; prepared: FtxPacket | null; messages: FtxMessage[] }

export class FtxSession {
  private modemPromise: Promise<FtxModem> | null = null;
  private loadModem: () => Promise<FtxModem>;
  private state: FtxSessionState = { mode: 'FT8', receiving: false, source: 'receiver', busy: false, coverage: 0, skipped: 0, error: '', status: 'Ready', prepared: null, messages: [] };
  private listeners = new Set<(state: FtxSessionState) => void>();
  private collector = new UtcSlotCollector('FT8');
  private resampler: PcmResampler | null = null;
  private inputRate = 0;
  private inputSource = '';
  private captureEpoch = 0;
  private configurationEpoch = 0;
  private prepareToken = 0;
  private preparing = 0;
  private decoding = false;
  private disposed = false;
  constructor(load: () => Promise<FtxModem>) { this.loadModem = load; }
  getState(): FtxSessionState { return { ...this.state, messages: [...this.state.messages] }; }
  subscribe(listener: (state: FtxSessionState) => void): () => void { this.listeners.add(listener); listener(this.getState()); return () => this.listeners.delete(listener); }
  private update(change: Partial<FtxSessionState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...change, busy: this.preparing > 0 || this.decoding };
    const state = this.getState(); this.listeners.forEach(listener => listener(state));
  }
  private modem(): Promise<FtxModem> {
    if (this.disposed) return Promise.reject(new Error('FT8/FT4 session has been disposed.'));
    return this.modemPromise ??= this.loadModem().catch(error => { this.modemPromise = null; throw error; });
  }
  private resetCapture(mode = this.state.mode): void {
    this.captureEpoch++; this.collector.discard(mode); this.resampler = null; this.inputSource = '';
  }
  configure(mode: FtxMode, source: 'receiver' | 'sdr'): void {
    if (mode === this.state.mode && source === this.state.source) return;
    if (source !== 'receiver' && source !== 'sdr') throw new Error('Select receiver or SDR audio.');
    this.resetCapture(mode); this.configurationEpoch++; this.prepareToken++;
    this.update({ mode, source, prepared: null, coverage: 0, skipped: this.collector.skipped, status: 'Ready', error: '' });
  }
  async prepare(message: string, options: { audioHz: number; volume: number; freeText: boolean }): Promise<FtxPacket> {
    const mode = this.state.mode, generation = this.configurationEpoch, token = ++this.prepareToken;
    this.preparing++; this.update({ error: '', status: 'Encoding' });
    const current = () => !this.disposed && generation === this.configurationEpoch && token === this.prepareToken;
    try {
      const modem = await this.modem(); if (!current()) throw new Error('Digital preparation was canceled or superseded.');
      const packet = await modem.encode(message, mode, { ...options, sampleRate: 12000 });
      if (!current()) throw new Error('Digital preparation was canceled or superseded.');
      this.update({ prepared: packet, status: `Prepared ${mode} waveform` }); return packet;
    } catch (error) {
      if (current()) this.update({ error: error instanceof Error ? error.message : String(error), status: 'Encoding failed' });
      throw error;
    } finally { this.preparing--; this.update({}); }
  }
  startReceive(): void { this.resetCapture(); this.update({ receiving: true, coverage: 0, skipped: this.collector.skipped, error: '', status: 'Waiting for a complete UTC receive slot' }); }
  stopReceive(): void { this.resetCapture(); this.update({ receiving: false, coverage: 0, skipped: this.collector.skipped, status: 'Receive paused' }); }
  interruptReceive(): void { this.resetCapture(); this.update({ coverage: 0, skipped: this.collector.skipped, status: this.state.receiving ? 'Waiting for a fresh receive slot' : 'Ready' }); }
  feed(samples: Float32Array, sampleRate: number, endUtcMs: number, source: 'receiver' | 'sdr', identity: string, continuityKnown = false): void {
    if (this.disposed || !this.state.receiving || source !== this.state.source) return;
    try {
      if (sampleRate !== this.inputRate || identity !== this.inputSource || !this.resampler) {
        this.resetCapture(); this.inputRate = sampleRate; this.inputSource = identity; this.resampler = new PcmResampler(sampleRate);
      }
      const discontinuities = this.collector.discontinuities;
      const normalized = this.resampler.process(samples), windows = this.collector.push(normalized, endUtcMs, continuityKnown);
      if (this.collector.discontinuities !== discontinuities) this.captureEpoch++;
      for (const window of windows) {
        if (this.decoding) { this.collector.skipped++; continue; }
        void this.decodeWindow(window.samples, window.sampleRate, window.slotUtcMs, window.mode, identity, true).catch(() => {});
      }
      this.update({ coverage: this.collector.coverage, skipped: this.collector.skipped });
    } catch (error) { this.resetCapture(); this.update({ error: error instanceof Error ? error.message : String(error), status: 'Receive input failed', coverage: 0, receiving: false }); }
  }
  async decodeWindow(samples: Float32Array, sampleRate: number, utc: number, mode = this.state.mode, source = 'Imported WAV', live = false): Promise<FtxMessage[]> {
    if (this.disposed) throw new Error('FT8/FT4 session has been disposed.');
    if (this.decoding) throw new Error('A receive window is already being decoded.');
    const generation = live ? this.captureEpoch : this.configurationEpoch;
    const current = () => !this.disposed && generation === (live ? this.captureEpoch : this.configurationEpoch);
    this.decoding = true; this.update({ error: '', status: `Decoding ${mode}` });
    try {
      const modem = await this.modem(); if (!current()) return [];
      const results = await modem.decode(samples, sampleRate, mode); if (!current()) return [];
      const messages = results.map(result => ({ ...result, id: crypto.randomUUID(), utc: new Date(utc).toISOString(), source }));
      this.update({ messages: [...messages, ...this.state.messages].slice(0, 500), status: messages.length ? `${messages.length} verified ${mode} decodes` : `No ${mode} messages decoded` });
      return messages;
    } catch (error) {
      if (current()) this.update({ error: error instanceof Error ? error.message : String(error), status: 'Decode failed' });
      throw error;
    } finally { this.decoding = false; this.update({}); }
  }
  clearMessages(): void { this.update({ messages: [], error: '' }); }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.stopReceive(); this.configurationEpoch++; this.prepareToken++; this.disposed = true; this.listeners.clear();
    this.state = { ...this.state, busy: false, receiving: false, prepared: null, status: 'Closed' };
    const loading = this.modemPromise; this.modemPromise = null;
    (await loading?.catch(() => null))?.dispose();
  }
}
