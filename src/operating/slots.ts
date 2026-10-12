export type FtxMode = 'FT8' | 'FT4';
export function slotMilliseconds(mode: FtxMode): number {
  if (mode !== 'FT8' && mode !== 'FT4') throw new RangeError('Mode must be FT8 or FT4.');
  return mode === 'FT8' ? 15000 : 7500;
}
export function nextSlotStart(nowUtcMs: number, mode: FtxMode, parity: 'next' | 'even' | 'odd' = 'next'): number {
  if (!Number.isFinite(nowUtcMs)) throw new RangeError('Invalid UTC time.');
  const period = slotMilliseconds(mode); let slot = Math.floor(nowUtcMs / period) + 1;
  if (parity !== 'next') {
    if (parity !== 'even' && parity !== 'odd') throw new RangeError('Choose next, even or odd slot parity.');
    const wanted = parity === 'even' ? 0 : 1;
    if ((slot % 2 + 2) % 2 !== wanted) slot++;
  }
  return slot * period;
}
export interface ReceiveWindow { samples: Float32Array; sampleRate: number; slotUtcMs: number; mode: FtxMode; coverage: number }

/** Builds UTC windows. Only fully present slots qualify; startup partial captures are discarded. */
export class UtcSlotCollector {
  private mode: FtxMode;
  private sampleRate: number;
  private slot: number | null = null;
  private samples: Float32Array;
  private present: Uint8Array;
  private filled = 0;
  private lastEnd: number | null = null;
  skipped = 0;
  discontinuities = 0;
  constructor(mode: FtxMode, sampleRate = 12000) {
    if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 192000) throw new RangeError('Invalid receive sample rate.');
    this.mode = mode; this.sampleRate = sampleRate;
    this.samples = new Float32Array(Math.round(slotMilliseconds(mode) / 1000 * sampleRate));
    this.present = new Uint8Array(this.samples.length);
  }
  reset(mode = this.mode): void {
    this.mode = mode; this.slot = null; this.lastEnd = null; this.filled = 0;
    this.samples = new Float32Array(Math.round(slotMilliseconds(mode) / 1000 * this.sampleRate));
    this.present = new Uint8Array(this.samples.length);
  }
  discard(mode = this.mode): void { if (this.filled) this.skipped++; this.reset(mode); }
  get coverage(): number { return this.filled / this.samples.length; }
  get currentSlotUtcMs(): number | null { return this.slot === null ? null : this.slot * slotMilliseconds(this.mode); }
  /** Proven sample continuity permits delivery jitter. Sources must reset identity on every known drop. */
  push(samples: Float32Array, endUtcMs: number, continuityKnown = false): ReceiveWindow[] {
    const windows: ReceiveWindow[] = [];
    if (!samples.length || !Number.isFinite(endUtcMs)) return windows;
    const duration = samples.length / this.sampleRate * 1000;
    if (this.lastEnd !== null) {
      const expectedEnd = this.lastEnd + duration;
      if (Math.abs(endUtcMs - expectedEnd) > (continuityKnown ? 250 : 20)) {
        const hadSamples = this.filled > 0;
        this.discard(); this.discontinuities++; if (!hadSamples) this.skipped++;
      } else endUtcMs = expectedEnd;
    }
    this.lastEnd = endUtcMs;
    const period = slotMilliseconds(this.mode), start = endUtcMs - duration;
    for (let i = 0; i < samples.length; i++) {
      const time = start + i / this.sampleRate * 1000, slot = Math.floor(time / period);
      if (this.slot === null) this.slot = slot;
      if (slot !== this.slot) {
        // A one-sample tolerance handles floating-point placement at an exact boundary.
        if (this.filled >= this.samples.length - 1) windows.push({ samples: this.samples, sampleRate: this.sampleRate, slotUtcMs: this.slot * period, mode: this.mode, coverage: this.coverage });
        else this.skipped++;
        this.slot = slot; this.samples = new Float32Array(Math.round(period / 1000 * this.sampleRate));
        this.present = new Uint8Array(this.samples.length); this.filled = 0;
      }
      const index = Math.round((time - slot * period) / 1000 * this.sampleRate);
      if (index >= 0 && index < this.samples.length) {
        this.samples[index] = samples[i]; if (!this.present[index]) { this.present[index] = 1; this.filled++; }
      }
    }
    return windows;
  }
}
