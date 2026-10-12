/** In-place radix-2, forward FFT. The transform is unnormalised. */
export function fft(real: Float32Array | Float64Array, imaginary: Float32Array | Float64Array): void {
  const n = real.length;
  if (n < 2 || (n & (n - 1)) !== 0 || imaginary.length !== n) throw new RangeError('FFT length must be a power of two and arrays must match.');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const phase = -2 * Math.PI / size;
    for (let base = 0; base < n; base += size) {
      for (let j = 0; j < half; j++) {
        const c = Math.cos(phase * j), s = Math.sin(phase * j);
        const a = base + j, b = a + half;
        const tr = real[b] * c - imaginary[b] * s;
        const ti = real[b] * s + imaginary[b] * c;
        real[b] = real[a] - tr; imaginary[b] = imaginary[a] - ti;
        real[a] += tr; imaginary[a] += ti;
      }
    }
  }
}

export interface SpectrumMeasurement {
  bins: Float32Array;
  sampleRate: number;
  fftSize: number;
  peakHz: number;
  peakDb: number;
  noiseDb: number;
  rms: number;
}

/** Hann-windowed one-sided amplitude spectrum, in dBFS per FFT bin. */
export function analyzeSpectrum(samples: Float32Array, sampleRate: number): SpectrumMeasurement {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('Sample rate must be positive.');
  const n = samples.length;
  if (n < 8 || (n & (n - 1)) !== 0) throw new RangeError('Spectrum requires a power-of-two length of at least eight samples.');
  const real = new Float64Array(n), imaginary = new Float64Array(n);
  let windowSum = 0, energy = 0;
  for (let i = 0; i < n; i++) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    const sample = Number.isFinite(samples[i]) ? samples[i] : 0;
    real[i] = sample * window;
    windowSum += window;
    energy += sample * sample;
  }
  fft(real, imaginary);
  const bins = new Float32Array(n / 2);
  let peakBin = 1;
  for (let i = 0; i < bins.length; i++) {
    const magnitude = Math.hypot(real[i], imaginary[i]) * (i === 0 ? 1 : 2) / windowSum;
    bins[i] = Math.max(-140, 20 * Math.log10(Math.max(1e-7, magnitude)));
    if (i > 0 && bins[i] > bins[peakBin]) peakBin = i;
  }
  // A parabola in log magnitude reduces frequency quantisation for isolated tones.
  let offset = 0;
  if (peakBin > 0 && peakBin < bins.length - 1) {
    const a = bins[peakBin - 1], b = bins[peakBin], c = bins[peakBin + 1];
    const denominator = a - 2 * b + c;
    if (Math.abs(denominator) > 1e-8) offset = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denominator));
  }
  const sorted = Array.from(bins.subarray(1)).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const noiseDb = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const rms = Math.sqrt(energy / n);
  return { bins, sampleRate, fftSize: n, peakHz: rms > 1e-7 ? (peakBin + offset) * sampleRate / n : 0, peakDb: bins[peakBin], noiseDb, rms };
}
