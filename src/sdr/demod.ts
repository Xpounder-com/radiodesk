import { validateSampleRate } from './iq.ts';

export interface DemodulationOptions {
  mode: 'AM' | 'FM' | 'USB' | 'LSB';
  /** Relative to the RF centre frequency, in Hz. */
  offsetHz: number;
  /** Total RF channel bandwidth for AM/FM; audio passband upper edge for SSB. */
  bandwidthHz: number;
  fmDeviationHz?: number;
}
export interface DemodulatedAudio { samples: Float32Array; sampleRate: number }

class Lowpass {
  private b0: number; private b1: number; private b2: number; private a1: number; private a2: number;
  private z1 = 0; private z2 = 0;
  constructor(sampleRate: number, cutoff: number, q: number) {
    const w = 2 * Math.PI * cutoff / sampleRate, c = Math.cos(w), s = Math.sin(w), alpha = s / (2 * q), a0 = 1 + alpha;
    this.b0 = (1 - c) / (2 * a0); this.b1 = (1 - c) / a0; this.b2 = this.b0;
    this.a1 = -2 * c / a0; this.a2 = (1 - alpha) / a0;
  }
  process(x: number): number { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
}

/** Streaming NCO, Butterworth complex channel filter, integer decimation and detector. */
export class IqDemodulator {
  readonly audioSampleRate: number;
  readonly decimation: number;
  private sampleRate: number;
  private options: DemodulationOptions;
  private filtersI: Lowpass[];
  private filtersQ: Lowpass[];
  private outputFilters: Lowpass[];
  private ncoCos = 1; private ncoSin = 0; private stepCos: number; private stepSin: number;
  private audioCos = 1; private audioSin = 0; private audioStepCos: number; private audioStepSin: number;
  private counter = 0; private renormalize = 0;
  private previousI = 0; private previousQ = 0; private hasPrevious = false;
  private previousAudio = 0; private dcOutput = 0;

  constructor(sampleRate: number, options: DemodulationOptions) {
    this.sampleRate = validateSampleRate(sampleRate); this.options = { ...options };
    if (!['AM', 'FM', 'USB', 'LSB'].includes(options.mode)) throw new RangeError('Demodulation mode must be AM, FM, USB or LSB.');
    if (!Number.isFinite(options.offsetHz) || Math.abs(options.offsetHz) >= sampleRate / 2) throw new RangeError('Channel offset must lie inside the IQ Nyquist span.');
    if (!Number.isFinite(options.bandwidthHz) || options.bandwidthHz < 300 || options.bandwidthHz > Math.min(200_000, sampleRate * 0.8)) throw new RangeError('Channel bandwidth must be 300 Hz to min(200 kHz, 80% of IQ rate).');
    if (!Number.isFinite(options.fmDeviationHz ?? 2500) || (options.fmDeviationHz ?? 2500) <= 0) throw new RangeError('FM deviation must be positive.');
    const ssb = options.mode === 'USB' || options.mode === 'LSB';
    const midpoint = ssb ? (options.bandwidthHz + 150) / 2 * (options.mode === 'USB' ? 1 : -1) : 0;
    const cutoff = ssb ? (options.bandwidthHz - 150) / 2 : options.bandwidthHz / 2;
    if (Math.abs(options.offsetHz + midpoint) + cutoff >= sampleRate / 2) throw new RangeError('Selected channel crosses the IQ Nyquist edge.');
    // Keep the output Nyquist above the selected channel, including wide FM.
    const desiredRate = Math.max(48_000, options.bandwidthHz * 2.5);
    this.decimation = Math.max(1, Math.floor(sampleRate / desiredRate));
    this.audioSampleRate = sampleRate / this.decimation;
    const qValues = ssb ? [0.5097955791041592, 0.6013448869350453, 0.8999762231364156, 2.5629154477415064] : [0.5176380902050415, Math.SQRT1_2, 1.9318516525781366];
    this.filtersI = qValues.map(q => new Lowpass(sampleRate, cutoff, q));
    this.filtersQ = qValues.map(q => new Lowpass(sampleRate, cutoff, q));
    const outputCutoff = Math.min(15_000, ssb ? options.bandwidthHz : options.bandwidthHz / 2, this.audioSampleRate * 0.4);
    this.outputFilters = [0.5176380902050415, Math.SQRT1_2, 1.9318516525781366].map(q => new Lowpass(this.audioSampleRate, outputCutoff, q));
    const step = -2 * Math.PI * (options.offsetHz + midpoint) / sampleRate;
    this.stepCos = Math.cos(step); this.stepSin = Math.sin(step);
    const audioStep = 2 * Math.PI * midpoint / this.audioSampleRate;
    this.audioStepCos = Math.cos(audioStep); this.audioStepSin = Math.sin(audioStep);
  }

  process(iq: Float32Array): DemodulatedAudio {
    if (iq.length % 2 !== 0) throw new RangeError('Demodulation requires complete I,Q pairs.');
    const output = new Float32Array(Math.ceil(iq.length / 2 / this.decimation) + 1);
    let count = 0;
    const ssb = this.options.mode === 'USB' || this.options.mode === 'LSB';
    const dcCoefficient = Math.exp(-2 * Math.PI * 20 / this.audioSampleRate);
    for (let k = 0; k < iq.length; k += 2) {
      const inputI = iq[k]!, inputQ = iq[k + 1]!;
      if (!Number.isFinite(inputI) || !Number.isFinite(inputQ)) throw new Error('IQ samples must be finite.');
      let i = inputI * this.ncoCos - inputQ * this.ncoSin;
      let q = inputI * this.ncoSin + inputQ * this.ncoCos;
      const newCos = this.ncoCos * this.stepCos - this.ncoSin * this.stepSin;
      this.ncoSin = this.ncoSin * this.stepCos + this.ncoCos * this.stepSin; this.ncoCos = newCos;
      if (++this.renormalize === 4096) { const norm = Math.hypot(this.ncoCos, this.ncoSin); this.ncoCos /= norm; this.ncoSin /= norm; this.renormalize = 0; }
      for (let stage = 0; stage < this.filtersI.length; stage++) { i = this.filtersI[stage]!.process(i); q = this.filtersQ[stage]!.process(q); }
      if (++this.counter < this.decimation) continue;
      this.counter = 0;
      let audio: number;
      if (this.options.mode === 'AM') audio = Math.hypot(i, q);
      else if (this.options.mode === 'FM') {
        audio = this.hasPrevious ? Math.atan2(q * this.previousI - i * this.previousQ, i * this.previousI + q * this.previousQ) * this.audioSampleRate / (2 * Math.PI * (this.options.fmDeviationHz ?? 2500)) : 0;
        this.previousI = i; this.previousQ = q; this.hasPrevious = true;
      } else if (ssb) {
        audio = i * this.audioCos - q * this.audioSin;
        const c = this.audioCos * this.audioStepCos - this.audioSin * this.audioStepSin;
        this.audioSin = this.audioSin * this.audioStepCos + this.audioCos * this.audioStepSin; this.audioCos = c;
      } else audio = 0;
      // Remove AM carrier/DC and detector offset after detection, preserving AM envelopes.
      const blocked = audio - this.previousAudio + dcCoefficient * this.dcOutput;
      this.previousAudio = audio; this.dcOutput = blocked;
      let filtered = blocked; for (const filter of this.outputFilters) filtered = filter.process(filtered);
      output[count++] = filtered;
    }
    return { samples: output.slice(0, count), sampleRate: this.audioSampleRate };
  }
}
