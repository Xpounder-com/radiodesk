/** Maps AudioWorklet sample positions to UTC while identifying genuine sample-clock gaps. */
export class CaptureSampleClock {
  private rate: number;
  private previousEnd: number | null = null;
  private anchorUtc: number | null = null;
  private wallOffset: number | null = null;
  private gaps = 0;
  private reportedGaps = 0;
  constructor(sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('Capture sample rate must be positive.');
    this.rate = sampleRate;
  }
  get discontinuities(): number { return this.gaps; }
  observe(endFrame: number, frames: number, nowUtcMs: number, monotonicMs: number, contextTimeSeconds: number, reportedGaps = 0): { endUtcMs: number; discontinuities: number } {
    if (!Number.isInteger(endFrame) || !Number.isInteger(frames) || frames <= 0 || endFrame < frames || !Number.isInteger(reportedGaps) || reportedGaps < 0 || ![nowUtcMs, monotonicMs, contextTimeSeconds].every(Number.isFinite)) throw new RangeError('Invalid audio sample-clock metadata.');
    const offset = nowUtcMs - monotonicMs;
    const reportIncrease = Math.max(0, reportedGaps - this.reportedGaps);
    const sampleGap = reportIncrease > 0 || (this.previousEnd !== null && endFrame !== this.previousEnd + frames);
    const wallJump = this.wallOffset !== null && Math.abs(offset - this.wallOffset) > 250;
    const contextPause = this.anchorUtc !== null && Math.abs(nowUtcMs - this.anchorUtc - contextTimeSeconds * 1000) > 250;
    if (sampleGap || wallJump || contextPause) { this.gaps += Math.max(1, reportIncrease); this.anchorUtc = null; this.wallOffset = null; }
    if (this.anchorUtc === null) this.anchorUtc = nowUtcMs - contextTimeSeconds * 1000;
    if (this.wallOffset === null) this.wallOffset = offset;
    this.previousEnd = endFrame;
    this.reportedGaps = reportedGaps;
    return { endUtcMs: this.anchorUtc + endFrame / this.rate * 1000, discontinuities: this.gaps };
  }
}
