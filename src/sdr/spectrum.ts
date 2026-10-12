import { fft } from '../dsp/fft.ts';
import { validateFrequency, validateSampleRate } from './iq.ts';

export interface IqSpectrum {
  bins: Float32Array;
  sampleRate: number;
  centerFrequency: number;
  fftSize: number;
  peakFrequency: number;
  peakOffsetHz: number;
  peakDb: number;
  noiseDb: number;
  rms: number;
  /** First bin frequency, inclusive; the upper RF edge is exclusive. */
  minimumFrequency: number;
  maximumFrequency: number;
}

/** Full, fftshift complex spectrum: negative and positive RF offsets are distinct. */
export function analyzeIqSpectrum(iq: Float32Array, sampleRate: number, centerFrequency: number): IqSpectrum {
  validateSampleRate(sampleRate); validateFrequency(centerFrequency);
  const n = iq.length / 2;
  if (!Number.isInteger(n) || n < 64 || n > 65536 || (n & (n - 1)) !== 0) throw new RangeError('Complex FFT size must be a power of two from 64 to 65536.');
  const re = new Float64Array(n), im = new Float64Array(n);
  let sumI = 0, sumQ = 0, windowSum = 0;
  const windows = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(iq[2 * i]) || !Number.isFinite(iq[2 * i + 1])) throw new Error('IQ samples must be finite.');
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); windows[i] = window; windowSum += window;
    sumI += iq[2 * i]! * window; sumQ += iq[2 * i + 1]! * window;
  }
  // Window-weighted DC removal avoids a residual centre spur from applying a
  // Hann window after subtracting an unweighted mean of a non-bin-centred tone.
  const meanI = sumI / windowSum, meanQ = sumQ / windowSum;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const window = windows[i]!;
    const a = iq[2 * i]! - meanI, b = iq[2 * i + 1]! - meanQ;
    re[i] = a * window; im[i] = b * window; energy += a * a + b * b;
  }
  fft(re, im);
  const bins = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const original = (i + n / 2) % n;
    // Complex analytic signals use no real-FFT factor of two.
    bins[i] = Math.max(-160, 20 * Math.log10(Math.max(1e-8, Math.hypot(re[original]!, im[original]!) / windowSum)));
    if (bins[i]! > bins[peak]!) peak = i;
  }
  let delta = 0;
  if (peak > 0 && peak < n - 1) {
    const a = bins[peak - 1]!, b = bins[peak]!, c = bins[peak + 1]!, denominator = a - 2 * b + c;
    if (Math.abs(denominator) > 1e-9) delta = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denominator));
  }
  const rms = Math.sqrt(energy / n), offset = rms > 1e-8 ? (peak + delta - n / 2) * sampleRate / n : 0;
  const sorted = Array.from(bins).sort((a, b) => a - b);
  return { bins, sampleRate, centerFrequency, fftSize: n, peakFrequency: centerFrequency + offset, peakOffsetHz: offset, peakDb: bins[peak]!, noiseDb: (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2, rms, minimumFrequency: centerFrequency - sampleRate / 2, maximumFrequency: centerFrequency + sampleRate / 2 };
}
