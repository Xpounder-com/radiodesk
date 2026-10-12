import { IqDemodulator } from './demod.ts';
import type { DemodulationOptions } from './demod.ts';
import { decodeIq, validateFrequency, validateSampleRate } from './iq.ts';
import type { IqFormat, IqRecording } from './iq.ts';
import { RtlTcpParser, rtlCommand, U8IqDecoder } from './protocol.ts';
import type { RtlTcpHeader } from './protocol.ts';
import type { IqSpectrum } from './spectrum.ts';
import { AudioResampler } from './resample.ts';

declare const __RADIO_DESK_SDR_WORKER__: string;
export interface SdrFrame extends IqSpectrum { timestamp: number; source: string }
export interface SdrAudioFrame {
  samples: Float32Array; sampleRate: number; timestamp: number; source: string;
  /** Cumulative skipped IQ sample count, so slot decoders can reject discontinuous captures. */
  droppedSamples: number;
  /** Requested centre plus software channel offset, Hz; hardware has no readback. */
  frequencyHz: number;
  configurationRevision: number;
}
export interface SdrConnectOptions { centerFrequency: number; sampleRate: number; gainDb?: number | null; fftSize?: number }
export interface SdrStats {
  state: 'stopped' | 'connecting' | 'receiving' | 'recording' | 'synthetic' | 'error';
  source: string;
  endpoint: string | null;
  header: RtlTcpHeader | null;
  sampleRate: number;
  centerFrequency: number;
  gainDb: number | null;
  fftSize: number;
  receivedBytes: number;
  receivedSamples: number;
  droppedSamples: number;
  droppedBlocks: number;
  droppedAudioBlocks: number;
  pendingBlocks: number;
  /** rtl_tcp has no command acknowledgements or RF frequency readback. */
  controlStatus: 'requested without hardware readback' | 'recording metadata' | 'synthetic fixture';
  listening: boolean;
  demodulation: DemodulationOptions;
  configurationRevision: number;
  lastError: string | null;
}

/** Real rtl_tcp-over-WebSocket IQ client plus bounded offline IQ playback. Receive only. */
export class SdrController {
  private listeners = new Set<(frame: SdrFrame) => void>();
  private audioListeners = new Set<(frame: SdrAudioFrame) => void>();
  private socket: WebSocket | null = null;
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private parser = new RtlTcpParser();
  private decoder = new U8IqDecoder();
  private epoch = 0;
  private settleUntil = 0;
  private recording: IqRecording | null = null;
  private recordingPosition = 0;
  private recordingLoop = false;
  private audioContext: AudioContext | null = null;
  private audioGain: GainNode | null = null;
  private audioSources = new Set<AudioBufferSourceNode>();
  private nextAudioTime = 0;
  private volume = 0.5;
  private speakerResampler: AudioResampler | null = null;
  private listeningRevision = 0;
  private resetAfterDrop = false;
  private pendingConnect: ((reason: Error) => void) | null = null;
  private status: SdrStats = {
    state: 'stopped', source: 'Stopped', endpoint: null, header: null,
    sampleRate: 2_048_000, centerFrequency: 100_000_000, gainDb: null, fftSize: 4096,
    receivedBytes: 0, receivedSamples: 0, droppedSamples: 0, droppedBlocks: 0, droppedAudioBlocks: 0, pendingBlocks: 0,
    controlStatus: 'requested without hardware readback', listening: false,
    demodulation: { mode: 'AM', offsetHz: 0, bandwidthHz: 10000 }, configurationRevision: 0, lastError: null,
  };

  get stats(): SdrStats { return { ...this.status, header: this.status.header ? { ...this.status.header } : null, demodulation: { ...this.status.demodulation } }; }
  subscribe(listener: (frame: SdrFrame) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Audio is delivered even while speakers are muted; no transmit action is taken. */
  subscribeAudio(listener: (frame: SdrAudioFrame) => void): () => void { this.audioListeners.add(listener); return () => this.audioListeners.delete(listener); }

  private validateFftSize(size = 4096): number {
    if (!Number.isInteger(size) || size < 256 || size > 16384 || (size & (size - 1)) !== 0) throw new RangeError('SDR FFT size must be a power of two from 256 to 16384.');
    return size;
  }
  private createWorker(): void {
    if (typeof __RADIO_DESK_SDR_WORKER__ !== 'string') throw new Error('The SDR worker is missing from this build. Rebuild the single-file distribution.');
    const url = URL.createObjectURL(new Blob([__RADIO_DESK_SDR_WORKER__], { type: 'text/javascript' }));
    try { this.worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
    const worker = this.worker, epoch = this.epoch;
    this.status.configurationRevision++;
    worker.onmessage = (event: MessageEvent) => {
      if (this.worker !== worker || this.epoch !== epoch) return;
      const data = event.data;
      if (data.type === 'ack') this.status.pendingBlocks = Math.max(0, this.status.pendingBlocks - 1);
      else if (data.configurationRevision !== this.status.configurationRevision) return;
      else if (data.type === 'frame') {
        for (const listener of this.listeners) { try { listener(data.frame as SdrFrame); } catch (e) { console.error('SDR frame listener failed', e); } }
      } else if (data.type === 'audio') {
        const frame = { ...data, droppedSamples: this.status.droppedSamples, frequencyHz: this.status.centerFrequency + this.status.demodulation.offsetHz } as SdrAudioFrame;
        for (const listener of this.audioListeners) { try { listener(frame); } catch (e) { console.error('SDR audio listener failed', e); } }
        this.playAudio(frame);
      } else if (data.type === 'error') { this.status.lastError = data.error; this.status.state = 'error'; }
    };
    worker.onerror = event => { if (this.worker !== worker || this.epoch !== epoch) return; this.status.lastError = event.message || 'SDR worker failed'; this.status.state = 'error'; };
    worker.postMessage({ type: 'init', sampleRate: this.status.sampleRate, centerFrequency: this.status.centerFrequency, fftSize: this.status.fftSize, source: this.status.source, demodulation: this.status.demodulation, configurationRevision: this.status.configurationRevision });
  }

  private acceptIq(iq: Float32Array): void {
    const samples = iq.length / 2;
    this.status.receivedSamples += samples;
    if (!samples || !this.worker) return;
    if (this.status.pendingBlocks >= 4 || performance.now() < this.settleUntil) {
      this.status.droppedSamples += samples; this.status.droppedBlocks++; this.resetAfterDrop = true; return;
    }
    if (this.resetAfterDrop) { this.status.configurationRevision++; this.worker.postMessage({ type: 'config', configurationRevision: this.status.configurationRevision }); this.resetAfterDrop = false; }
    this.status.pendingBlocks++;
    this.worker.postMessage({ type: 'iq', buffer: iq.buffer, timestamp: performance.now() }, [iq.buffer]);
  }

  private send(bytes: Uint8Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.status.header) throw new Error('Connect to a valid rtl_tcp IQ receiver before changing hardware controls.');
    if (this.socket.bufferedAmount > 4096) throw new Error('SDR control channel is congested; wait before tuning again.');
    this.socket.send(bytes);
  }

  async connect(endpoint: string, options: SdrConnectOptions): Promise<void> {
    const url = new URL(endpoint);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('SDR endpoint must be a ws:// or wss:// URL without credentials or fragments.');
    // A remotely hosted project may choose an explicit authenticated WSS native
    // endpoint; the supplied Python bridge only connects local loopback devices.
    if (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Unencrypted IQ transport is restricted to loopback. Use an explicit wss:// receiver endpoint for a remote native service.');
    validateFrequency(options.centerFrequency); validateSampleRate(options.sampleRate);
    if (!((options.sampleRate >= 225001 && options.sampleRate <= 300000) || (options.sampleRate >= 900001 && options.sampleRate <= 3200000))) throw new RangeError('rtl_tcp RTL-SDR hardware sample rate must be 225,001–300,000 or 900,001–3,200,000 Hz. Lower rates are supported for offline IQ import.');
    const fftSize = this.validateFftSize(options.fftSize);
    if (options.gainDb !== undefined && options.gainDb !== null && (!Number.isFinite(options.gainDb) || Math.abs(options.gainDb) > 100)) throw new RangeError('Requested tuner gain must be between −100 and +100 dB.');
    new IqDemodulator(options.sampleRate, this.status.demodulation);
    this.disconnect();
    const epoch = this.epoch;
    this.parser = new RtlTcpParser(); this.decoder = new U8IqDecoder();
    Object.assign(this.status, { state: 'connecting', source: 'rtl_tcp wideband IQ', endpoint: url.href, header: null, centerFrequency: options.centerFrequency, sampleRate: options.sampleRate, gainDb: options.gainDb ?? null, fftSize, receivedBytes: 0, receivedSamples: 0, droppedSamples: 0, droppedBlocks: 0, droppedAudioBlocks: 0, controlStatus: 'requested without hardware readback', lastError: null });
    try { this.createWorker(); } catch (e) { this.status.state = 'error'; this.status.lastError = String(e); throw e; }
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url.href); this.socket = socket; socket.binaryType = 'arraybuffer';
      let ready = false, finished = false;
      const timeout = setTimeout(() => fail(new Error('SDR connection timed out before a valid RTL0 header was received.')), 8000);
      const fail = (reason: Error): void => {
        if (finished) return; finished = true; clearTimeout(timeout); this.pendingConnect = null;
        this.status.lastError = reason.message; this.status.state = 'error'; reject(reason);
        socket.close(); this.worker?.terminate(); this.worker = null; this.status.pendingBlocks = 0;
      };
      this.pendingConnect = fail;
      socket.onmessage = event => {
        if (epoch !== this.epoch) return;
        try {
          if (!(event.data instanceof ArrayBuffer)) throw new Error('rtl_tcp IQ endpoint must send binary WebSocket messages.');
          if (event.data.byteLength > 4 * 1024 * 1024) throw new Error('SDR transport message exceeds the 4 MiB bound.');
          this.status.receivedBytes += event.data.byteLength;
          const parsed = this.parser.push(new Uint8Array(event.data));
          if (parsed.header) {
            this.status.header = parsed.header;
            this.send(rtlCommand('sampleRate', options.sampleRate)); this.send(rtlCommand('frequency', options.centerFrequency)); this.setGain(options.gainDb ?? null);
            this.settleUntil = performance.now() + 100;
            ready = true; finished = true; clearTimeout(timeout); this.pendingConnect = null; this.status.state = 'receiving'; resolve();
          }
          // Small messages bound conversion and transferred worker allocations.
          for (let offset = 0; offset < parsed.iq.length; offset += 65536) this.acceptIq(this.decoder.decode(parsed.iq.subarray(offset, offset + 65536)));
        } catch (e) {
          const reason = e instanceof Error ? e : new Error(String(e));
          if (!ready) fail(reason); else { this.status.lastError = reason.message; this.status.state = 'error'; socket.close(); }
        }
      };
      socket.onerror = () => { if (!ready) fail(new Error('Could not reach the IQ WebSocket bridge. Start rtl_tcp and the supplied loopback bridge first.')); else { this.status.lastError = 'IQ WebSocket transport failed'; this.status.state = 'error'; } };
      socket.onclose = () => {
        if (epoch !== this.epoch) return;
        if (!ready) { fail(new Error('IQ bridge closed before the rtl_tcp header.')); return; }
        this.worker?.terminate(); this.worker = null; this.status.pendingBlocks = 0;
        if (this.status.state !== 'error') { this.status.state = 'stopped'; this.status.source = 'Disconnected IQ receiver'; }
      };
    });
  }

  tune(frequency: number): void {
    validateFrequency(frequency);
    if (this.status.state !== 'receiving') throw new Error('Hardware tuning requires a connected IQ receiver. Recording centre frequency is metadata and cannot retune a file.');
    this.send(rtlCommand('frequency', frequency)); this.status.centerFrequency = frequency;
    this.settleUntil = performance.now() + 100;
    this.status.configurationRevision++;
    this.worker?.postMessage({ type: 'config', centerFrequency: frequency, configurationRevision: this.status.configurationRevision });
  }

  setGain(db: number | null): void {
    if (db !== null && (!Number.isFinite(db) || Math.abs(db) > 100)) throw new RangeError('Requested tuner gain must be between −100 and +100 dB.');
    this.send(rtlCommand('gainMode', db === null ? 0 : 1));
    if (db !== null) this.send(rtlCommand('gain', Math.round(db * 10)));
    this.status.gainDb = db;
  }

  setDemodulation(options: DemodulationOptions): void {
    new IqDemodulator(this.status.sampleRate, options);
    this.status.demodulation = { ...options };
    this.status.configurationRevision++;
    this.worker?.postMessage({ type: 'config', demodulation: options, configurationRevision: this.status.configurationRevision });
    this.flushAudio();
  }

  importIq(buffer: ArrayBuffer, format: IqFormat): void {
    const recording = decodeIq(buffer, format), fftSize = this.validateFftSize(format.fftSize);
    new IqDemodulator(recording.sampleRate, this.status.demodulation);
    this.disconnect(); this.recording = recording; this.recordingPosition = 0; this.recordingLoop = format.loop ?? false;
    Object.assign(this.status, { state: 'recording', source: `Offline ${format.kind.toUpperCase()} IQ recording`, endpoint: null, header: null, sampleRate: recording.sampleRate, centerFrequency: recording.centerFrequency, fftSize, receivedBytes: buffer.byteLength, receivedSamples: 0, droppedSamples: 0, droppedBlocks: 0, droppedAudioBlocks: 0, controlStatus: 'recording metadata', lastError: null });
    this.createWorker();
    // Feed at recording wall-clock rate, preserving contiguous samples in blocks.
    let nextFrame = 0;
    this.timer = setInterval(() => {
      if (!this.recording) return;
      nextFrame += recording.sampleRate * 0.025;
      let remaining = Math.floor(nextFrame) - this.recordingPosition;
      while (remaining > 0) {
        const available = recording.sampleCount - this.recordingPosition;
        const count = Math.min(16384, remaining, available);
        if (count > 0) { this.acceptIq(recording.iq.slice(this.recordingPosition * 2, (this.recordingPosition + count) * 2)); this.recordingPosition += count; remaining -= count; }
        if (this.recordingPosition >= recording.sampleCount) {
          if (this.recordingLoop) { nextFrame -= recording.sampleCount; this.recordingPosition = 0; }
          else { if (this.timer) clearInterval(this.timer); this.timer = null; this.status.state = 'stopped'; this.status.source += ' · finished'; break; }
        }
      }
    }, 25);
  }

  /** Explicit deterministic fixture for UI/FFT checking; no live radio is involved. */
  startSynthetic(centerFrequency = 14_074_000): void {
    validateFrequency(centerFrequency); this.disconnect();
    Object.assign(this.status, { state: 'synthetic', source: 'Synthetic IQ fixture · not live RF', endpoint: null, header: null, sampleRate: 192000, centerFrequency, fftSize: 4096, receivedBytes: 0, receivedSamples: 0, droppedSamples: 0, droppedBlocks: 0, droppedAudioBlocks: 0, controlStatus: 'synthetic fixture', demodulation: { mode: 'AM', offsetHz: 20000, bandwidthHz: 10000 }, lastError: null });
    this.createWorker(); let position = 0, seed = 12345;
    this.timer = setInterval(() => {
      const iq = new Float32Array(9600);
      for (let n = 0; n < 4800; n++, position++) {
        const time = position / 192000; seed = (1664525 * seed + 1013904223) >>> 0;
        const amplitude = 0.45 * (1 + 0.4 * Math.sin(2 * Math.PI * 1000 * time));
        iq[n * 2] = amplitude * Math.cos(2 * Math.PI * 20000 * time) + (seed / 4294967296 - 0.5) * 0.01;
        seed = (1664525 * seed + 1013904223) >>> 0;
        iq[n * 2 + 1] = amplitude * Math.sin(2 * Math.PI * 20000 * time) + (seed / 4294967296 - 0.5) * 0.01;
      }
      this.status.receivedBytes += iq.byteLength; this.acceptIq(iq);
    }, 25);
  }

  async setListening(enabled: boolean, volume = this.volume): Promise<void> {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new RangeError('Listening volume must be between zero and one.');
    this.volume = volume;
    const revision = ++this.listeningRevision;
    if (!enabled) { this.status.listening = false; this.flushAudio(); await this.audioContext?.close(); this.audioContext = null; this.audioGain = null; return; }
    if (typeof AudioContext === 'undefined') throw new Error('This browser has no Web Audio listening support.');
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new AudioContext({ latencyHint: 'interactive' }); this.audioGain = this.audioContext.createGain(); this.audioGain.connect(this.audioContext.destination); this.nextAudioTime = this.audioContext.currentTime;
    }
    this.audioGain!.gain.value = volume; await this.audioContext.resume(); if (revision === this.listeningRevision) this.status.listening = true;
  }

  private playAudio(frame: SdrAudioFrame): void {
    const context = this.audioContext;
    if (!this.status.listening || !context || !this.audioGain || context.state !== 'running' || !frame.samples.length) return;
    if (this.nextAudioTime > context.currentTime + 0.3) { this.status.droppedAudioBlocks++; return; }
    // Browser AudioBuffer implementations need not accept the high detector
    // rates used by wide FM. Convert filtered audio to the actual output rate.
    if (!this.speakerResampler || this.speakerResampler.inputRate !== frame.sampleRate || this.speakerResampler.outputRate !== context.sampleRate) this.speakerResampler = new AudioResampler(frame.sampleRate, context.sampleRate);
    const samples = this.speakerResampler.process(frame.samples); if (!samples.length) return;
    const buffer = context.createBuffer(1, samples.length, context.sampleRate); buffer.copyToChannel(new Float32Array(samples), 0);
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(this.audioGain); this.audioSources.add(source);
    source.onended = () => { source.disconnect(); this.audioSources.delete(source); };
    this.nextAudioTime = Math.max(this.nextAudioTime, context.currentTime + 0.02); source.start(this.nextAudioTime); this.nextAudioTime += samples.length / context.sampleRate;
  }
  private flushAudio(): void {
    for (const source of this.audioSources) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
    this.audioSources.clear(); this.nextAudioTime = this.audioContext?.currentTime ?? 0; this.speakerResampler = null;
  }

  disconnect(): void {
    this.epoch++; this.pendingConnect?.(new Error('SDR connection cancelled.')); this.pendingConnect = null;
    if (this.timer) clearInterval(this.timer); this.timer = null; this.recording = null;
    if (this.socket) { this.socket.onmessage = null; this.socket.onclose = null; this.socket.onerror = null; this.socket.close(); this.socket = null; }
    this.worker?.terminate(); this.worker = null; this.status.pendingBlocks = 0; this.decoder.reset(); this.flushAudio();
    this.status.state = 'stopped'; this.status.source = 'Stopped'; this.status.endpoint = null; this.status.header = null; this.settleUntil = 0; this.resetAfterDrop = false;
  }
}
