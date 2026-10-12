export interface BiquadCoefficients { b0: number; b1: number; b2: number; a1: number; a2: number }

/** RBJ biquad coefficients; a0 is normalised to one. */
export function biquadCoefficients(type: 'lowpass' | 'highpass' | 'bandpass', frequency: number, sampleRate: number, q = Math.SQRT1_2): BiquadCoefficients {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(frequency) || frequency <= 0 || frequency >= sampleRate / 2 || !Number.isFinite(q) || q <= 0) throw new RangeError('Filter requires 0 < frequency < Nyquist and Q > 0.');
  const omega = 2 * Math.PI * frequency / sampleRate;
  const cosine = Math.cos(omega), alpha = Math.sin(omega) / (2 * q), a0 = 1 + alpha;
  let b0: number, b1: number, b2: number;
  if (type === 'lowpass') { b0 = (1 - cosine) / 2; b1 = 1 - cosine; b2 = b0; }
  else if (type === 'highpass') { b0 = (1 + cosine) / 2; b1 = -(1 + cosine); b2 = b0; }
  else { b0 = alpha; b1 = 0; b2 = -alpha; }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: -2 * cosine / a0, a2: (1 - alpha) / a0 };
}

export class BiquadFilter {
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  coefficients: BiquadCoefficients;
  constructor(coefficients: BiquadCoefficients) { this.coefficients = coefficients; }
  reset(): void { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  process(sample: number): number {
    const c = this.coefficients;
    const output = c.b0 * sample + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1; this.x1 = sample; this.y2 = this.y1; this.y1 = output;
    return output;
  }
  processBlock(samples: Float32Array): Float32Array {
    return Float32Array.from(samples, value => this.process(value));
  }
}

/** Receiver audio passband: cascaded second-order highpass and lowpass. */
export function bandpassCoefficients(lowHz: number, highHz: number, sampleRate: number): [BiquadCoefficients, BiquadCoefficients] {
  if (lowHz >= highHz) throw new RangeError('Passband low edge must be below the high edge.');
  return [biquadCoefficients('highpass', lowHz, sampleRate), biquadCoefficients('lowpass', highHz, sampleRate)];
}
