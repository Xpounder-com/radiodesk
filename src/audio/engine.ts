import { DSP_WORKER_SOURCE } from '../dsp/worker.ts';
import { CAPTURE_WORKLET_SOURCE } from './worklet.ts';
import { decodeWav, encodeWav } from './wav.ts';
import { CaptureSampleClock } from './sample-clock.ts';
import type { SpectrumMeasurement } from '../dsp/fft.ts';

export interface SignalFrame extends SpectrumMeasurement { timestamp: number }
export interface PcmFrame {samples:Float32Array;sampleRate:number;endUtcMs:number;source:string;generation:number;discontinuities:number;continuityKnown:boolean;}
type FrameListener = (frame: SignalFrame) => void;

/** Receive-only browser audio engine. No RF hardware or transmit path is implied. */
export class SignalEngine {
  private listeners = new Set<FrameListener>();
  private pcmListeners = new Set<(frame:PcmFrame)=>void>();
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private capture: AudioWorkletNode | null = null;
  private captureClock: CaptureSampleClock | null = null;
  private input: AudioBufferSourceNode | MediaStreamAudioSourceNode | null = null;
  private monitor: GainNode | null = null;
  private monitorFilters: BiquadFilterNode[] = [];
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private epoch = 0;
  private pending = 0;
  private _source = 'Stopped';
  private _sampleRate = 48000;
  private _droppedFrames = 0;
  private gain = 1;
  private lowHz = 20;
  private highHz = 12000;
  private recording = false;
  private recordingRate = 48000;
  private recordingChunks: Float32Array[] = [];
  private recordingSamples = 0;

  readonly fftSize = 2048;
  get source(): string { return this._source; }
  get sampleRate(): number { return this._sampleRate; }
  /** Number of sample blocks discarded to keep the DSP queue bounded. */
  get droppedFrames(): number { return this._droppedFrames; }
  get isRecording(): boolean { return this.recording; }
  get recordingDuration(): number { return this.recordingSamples / this.recordingRate; }

  subscribe(listener: FrameListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** PCM is borrowed until this callback returns; copy before retaining. Worklet UTC follows its sample clock, without ADC-latency calibration. */
  subscribePcm(listener:(frame:PcmFrame)=>void):()=>void{this.pcmListeners.add(listener);return()=>this.pcmListeners.delete(listener);}

  private createWorker(): void {
    const url = URL.createObjectURL(new Blob([DSP_WORKER_SOURCE], { type: 'text/javascript' }));
    try { this.worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
    this.pending = 0; this._droppedFrames = 0;
    this.worker.onmessage = (event: MessageEvent) => {
      if (event.data.type === 'ack') this.pending = Math.max(0, this.pending - 1);
      if (event.data.type === 'frame') for (const listener of this.listeners) listener(event.data.frame as SignalFrame);
    };
    this.worker.postMessage({ type: 'init', sampleRate: this.sampleRate, fftSize: this.fftSize, gain: this.gain, ...this.effectiveBandpass() });
  }

  private effectiveBandpass(): { lowHz: number; highHz: number } {
    const highHz = Math.min(this.highHz, this.sampleRate * 0.49);
    return { lowHz: Math.min(this.lowHz, highHz * 0.9), highHz };
  }

  private acceptSamples(samples: Float32Array, clock?: { endUtcMs: number; discontinuities: number }): void {
    const frame:PcmFrame={samples,sampleRate:this.sampleRate,endUtcMs:clock?.endUtcMs??Date.now(),source:this.source,generation:this.epoch,discontinuities:clock?.discontinuities??0,continuityKnown:!!clock};
    for(const listener of this.pcmListeners){try{listener(frame);}catch(error){console.error('Receiver PCM listener failed',error);}}
    if (this.recording) {
      // Ten minutes is a bounded in-memory capture, without silent truncation.
      if (this.recordingSamples + samples.length > this.recordingRate * 600) {
        this.recording = false;
        console.warn('RadioDesk recording reached the ten-minute in-memory limit. Download the recording to continue.');
      } else { this.recordingChunks.push(samples.slice()); this.recordingSamples += samples.length; }
    }
    if (!this.worker) return;
    if (this.pending >= 8) { this._droppedFrames++; return; }
    this.pending++;
    this.worker.postMessage({ type: 'samples', buffer: samples.buffer, timestamp: performance.now() }, [samples.buffer]);
  }

  /** Deterministic synthetic receiver audio; no live station or antenna is involved. */
  startDemo(): void {
    this.stop(); this._sampleRate = 48000;
    try { this.createWorker(); } catch (error) { this.stop(); throw error; }
    this._source = 'Synthetic demo';
    let position = 0, seed = 1234567;
    this.timer = setInterval(() => {
      const samples = new Float32Array(1200);
      for (let i = 0; i < samples.length; i++, position++) {
        const t = position / this.sampleRate;
        seed = (1664525 * seed + 1013904223) >>> 0;
        const noise = (seed / 4294967296 - 0.5) * 0.016;
        const cwKey = Math.floor(t * 6) % 8 < 3 ? 1 : 0;
        const carrier = 0.16 * Math.sin(2 * Math.PI * 700 * t) * cwKey;
        const rtty = 0.07 * Math.sin(2 * Math.PI * (Math.floor(t * 45.45) % 2 ? 2295 : 2125) * t);
        const reference = 0.03 * Math.sin(2 * Math.PI * 1450 * t);
        samples[i] = carrier + rtty + reference + noise;
      }
      this.acceptSamples(samples);
    }, 25);
  }

  private async openContext(epoch: number): Promise<AudioContext> {
    if (typeof AudioContext === 'undefined') throw new Error('This browser does not support Web Audio.');
    const context = new AudioContext({ latencyHint: 'interactive' });
    this.context = context;
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: 'text/javascript' }));
    try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    if (epoch !== this.epoch) { await context.close(); throw new Error('Audio start was cancelled.'); }
    await context.resume();
    if (epoch !== this.epoch) { await context.close(); throw new Error('Audio start was cancelled.'); }
    this._sampleRate = context.sampleRate;
    this.captureClock = new CaptureSampleClock(context.sampleRate);
    this.capture = new AudioWorkletNode(context, 'radiodesk-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.capture.port.onmessage = event => {
      if (epoch !== this.epoch || !this.captureClock) return;
      const samples = new Float32Array(event.data.buffer as ArrayBuffer);
      const clock = this.captureClock.observe(event.data.endFrame, samples.length, Date.now(), performance.now(), context.currentTime, event.data.discontinuities);
      this.acceptSamples(samples, clock);
    };
    this.capture.connect(context.destination); // Worklet's output is silence.
    return context;
  }

  async startMicrophone(deviceId?: string): Promise<void> {
    this.stop();
    const epoch = this.epoch;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture requires HTTPS, localhost, or a browser that permits local-file audio.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      if (epoch !== this.epoch) { stream.getTracks().forEach(track => track.stop()); throw new Error('Audio start was cancelled.'); }
      this.stream = stream;
      const context = await this.openContext(epoch);
      this.createWorker(); this.input = context.createMediaStreamSource(stream); this.input.connect(this.capture!);
      this._source = 'Microphone';
    } catch (error) { if (epoch === this.epoch) this.stop(); throw error; }
  }

  /** Playback is audible. The spectrum and monitor use the selected gain/passband. */
  async importWav(arrayBuffer: ArrayBuffer): Promise<void> {
    const audio = decodeWav(arrayBuffer);
    if (!audio.samples.length) throw new Error('WAV recording has no audio samples.');
    this.stop(); const epoch = this.epoch;
    try {
      const context = await this.openContext(epoch); this.createWorker();
      const buffer = context.createBuffer(1, audio.samples.length, audio.sampleRate);
      buffer.copyToChannel(new Float32Array(audio.samples), 0);
      const source = context.createBufferSource(); source.buffer = buffer; this.input = source;
      source.connect(this.capture!);
      const bandpass = this.effectiveBandpass();
      const highpass = context.createBiquadFilter(), lowpass = context.createBiquadFilter();
      highpass.type = 'highpass'; highpass.frequency.value = bandpass.lowHz; highpass.Q.value = Math.SQRT1_2;
      lowpass.type = 'lowpass'; lowpass.frequency.value = bandpass.highHz; lowpass.Q.value = Math.SQRT1_2;
      this.monitorFilters = [highpass, lowpass]; this.monitor = context.createGain(); this.monitor.gain.value = this.gain;
      source.connect(highpass); highpass.connect(lowpass); lowpass.connect(this.monitor); this.monitor.connect(context.destination);
      source.onended = () => { if (epoch === this.epoch) this.stop(); };
      this._source = 'WAV playback'; source.start();
    } catch (error) { if (epoch === this.epoch) this.stop(); throw error; }
  }

  setGain(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 20) throw new RangeError('Audio gain must be between 0 and 20.');
    this.gain = value; this.worker?.postMessage({ type: 'config', gain: value });
    if (this.monitor && this.context) this.monitor.gain.setTargetAtTime(value, this.context.currentTime, 0.01);
  }

  setBandpass(lowHz: number, highHz: number): void {
    if (!Number.isFinite(lowHz) || !Number.isFinite(highHz) || lowHz < 1 || highHz <= lowHz || highHz > 24000) throw new RangeError('Passband requires 1 ≤ low < high ≤ 24000 Hz.');
    this.lowHz = lowHz; this.highHz = highHz;
    const bandpass = this.effectiveBandpass(); this.worker?.postMessage({ type: 'config', ...bandpass });
    if (this.context && this.monitorFilters.length) {
      this.monitorFilters[0].frequency.setTargetAtTime(bandpass.lowHz, this.context.currentTime, 0.01);
      this.monitorFilters[1].frequency.setTargetAtTime(bandpass.highHz, this.context.currentTime, 0.01);
    }
  }

  startRecording(): void {
    if (this.source === 'Stopped') throw new Error('Start an audio source before recording.');
    if (this.recordingChunks.length) throw new Error('Download or finish the existing recording before starting another.');
    this.recordingRate = this.sampleRate; this.recordingSamples = 0; this.recording = true;
  }

  /** Raw received mono audio, before gain and filters; stop() preserves capture for download. */
  stopRecording(): Blob | null {
    this.recording = false;
    if (!this.recordingSamples) { this.recordingChunks = []; return null; }
    const samples = new Float32Array(this.recordingSamples); let offset = 0;
    for (const chunk of this.recordingChunks) { samples.set(chunk, offset); offset += chunk.length; }
    this.recordingChunks = []; this.recordingSamples = 0;
    return new Blob([encodeWav(samples, this.recordingRate)], { type: 'audio/wav' });
  }

  stop(): void {
    this.epoch++; this.recording = false;
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.input && typeof AudioBufferSourceNode !== 'undefined' && this.input instanceof AudioBufferSourceNode) { this.input.onended = null; try { this.input.stop(); } catch {} }
    this.input?.disconnect(); this.input = null;
    this.capture?.disconnect(); this.capture = null; this.captureClock = null;
    this.monitor?.disconnect(); this.monitor = null; this.monitorFilters.forEach(node => node.disconnect()); this.monitorFilters = [];
    this.worker?.terminate(); this.worker = null; this.pending = 0;
    if (this.context) { void this.context.close().catch(() => {}); this.context = null; }
    this._source = 'Stopped';
  }
}
