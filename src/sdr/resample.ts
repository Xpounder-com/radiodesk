/** Stateful linear interpolation for already low-pass-filtered detector audio. */
export class AudioResampler {
  readonly inputRate: number;
  readonly outputRate: number;
  private nextPosition = 0;
  private position = 0;
  private previous = 0;
  private hasPrevious = false;

  constructor(inputRate: number, outputRate: number) {
    if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate) || inputRate < 8000 || outputRate < 8000 || inputRate > 3_200_000 || outputRate > 768000) throw new RangeError('Invalid audio resampling rates.');
    this.inputRate = inputRate; this.outputRate = outputRate;
  }

  process(samples: Float32Array): Float32Array {
    const output = new Float32Array(Math.ceil(samples.length * this.outputRate / this.inputRate) + 2);
    let count = 0;
    const step = this.inputRate / this.outputRate;
    for (const sample of samples) {
      if (!Number.isFinite(sample)) throw new Error('Audio resampling requires finite samples.');
      if (!this.hasPrevious) { this.previous = sample; this.hasPrevious = true; }
      while (this.nextPosition <= this.position + 1e-10) {
        const fraction = Math.max(0, Math.min(1, this.nextPosition - (this.position - 1)));
        output[count++] = this.previous + (sample - this.previous) * fraction;
        this.nextPosition += step;
      }
      this.previous = sample; this.position++;
    }
    return output.slice(0, count);
  }
}
