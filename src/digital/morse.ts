import { encodeWav } from '../audio/wav.ts';
import { BiquadFilter, biquadCoefficients } from '../dsp/filters.ts';

export const MORSE_ALPHABET: Readonly<Record<string, string>> = Object.freeze({
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-', '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', '_': '..--.-', '"': '.-..-.', '$': '...-..-', '@': '.--.-.',
});
const REVERSE_MORSE = Object.fromEntries(Object.entries(MORSE_ALPHABET).map(([letter, code]) => [code, letter]));

export function encodeMorse(text: string): string {
  return text.trim().toUpperCase().split(/\s+/).filter(Boolean).map(word => [...word].map(letter => {
    const code = MORSE_ALPHABET[letter]; if (!code) throw new Error(`Unsupported Morse character: ${letter}`); return code;
  }).join(' ')).join(' / ');
}

export function decodeMorse(code: string): string {
  return code.trim().replace(/[·•]/g, '.').replace(/[−–—]/g, '-').split(/\s*\/\s*/).map(word => word.split(/\s+/).filter(Boolean).map(symbol => REVERSE_MORSE[symbol] ?? '�').join('')).join(' ');
}

export interface MorseTiming { keyed: boolean; units: number; durationMs: number }

/** ITU 1:3 elements, 1:3:7 spacing. A trailing word gap completes a 50-unit PARIS word. */
export function morseTiming(text: string, wpm = 20, farnsworthWpm = wpm): MorseTiming[] {
  if (!Number.isFinite(wpm) || wpm < 3 || wpm > 80 || !Number.isFinite(farnsworthWpm) || farnsworthWpm < 3 || farnsworthWpm > wpm) throw new RangeError('CW speed requires 3 ≤ effective WPM ≤ character WPM ≤ 80.');
  const dotMs = 1200 / wpm;
  const spacingDotMs = (60000 / farnsworthWpm - 31 * dotMs) / 19;
  const words = encodeMorse(text).split(' / ').filter(Boolean), result: MorseTiming[] = [];
  for (const word of words) {
    const letters = word.split(' ');
    letters.forEach((letter, letterIndex) => {
      [...letter].forEach((element, elementIndex) => {
        const units = element === '.' ? 1 : 3;
        result.push({ keyed: true, units, durationMs: dotMs * units });
        if (elementIndex < letter.length - 1) result.push({ keyed: false, units: 1, durationMs: dotMs });
      });
      if (letterIndex < letters.length - 1) result.push({ keyed: false, units: 3, durationMs: 3 * spacingDotMs });
    });
    result.push({ keyed: false, units: 7, durationMs: 7 * spacingDotMs });
  }
  return result;
}

export interface CwAudioOptions { wpm?: number; farnsworthWpm?: number; toneHz?: number; sampleRate?: number; volume?: number }

/** Offline practice audio with 5 ms raised-cosine edges. Returns a downloadable PCM16 WAV. */
export function generateCwWav(text: string, options: CwAudioOptions = {}): ArrayBuffer {
  const sampleRate = options.sampleRate ?? 48000, tone = options.toneHz ?? 700, volume = options.volume ?? 0.35;
  if (!Number.isFinite(tone) || tone < 100 || tone >= sampleRate / 2 || !Number.isFinite(volume) || volume < 0 || volume > 1) throw new RangeError('Invalid CW tone or volume.');
  const events = morseTiming(text, options.wpm ?? 20, options.farnsworthWpm ?? options.wpm ?? 20);
  const duration = events.reduce((sum, event) => sum + event.durationMs, 0) / 1000;
  if (duration > 600) throw new RangeError('Practice audio is limited to ten minutes.');
  const samples = new Float32Array(Math.ceil((duration + 0.2) * sampleRate));
  let elapsed = 0.1;
  for (const event of events) {
    const start = Math.round(elapsed * sampleRate); elapsed += event.durationMs / 1000; const end = Math.round(elapsed * sampleRate);
    if (event.keyed) {
      const ramp = Math.min(Math.round(sampleRate * 0.005), Math.floor((end - start) / 3));
      for (let i = start; i < end; i++) {
        const edge = Math.min(1, (i - start) / Math.max(1, ramp), (end - 1 - i) / Math.max(1, ramp));
        const envelope = 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, edge));
        samples[i] = volume * envelope * Math.sin(2 * Math.PI * tone * i / sampleRate);
      }
    }
  }
  return encodeWav(samples, sampleRate);
}

/** Key duration decoder. Fixed speed is intentional: a lone dash cannot reveal dot speed. */
export class MorseKeyDecoder {
  private code = '';
  private text = '';
  private lastUp: number | null = null;
  private downAt: number | null = null;
  private emittedSpace = false;
  private dotMs: number;
  private letterGapMs: number;
  private wordGapMs: number;
  constructor(wpm = 20, farnsworthWpm = wpm) {
    if (!Number.isFinite(wpm) || wpm < 3 || wpm > 80 || !Number.isFinite(farnsworthWpm) || farnsworthWpm < 3 || farnsworthWpm > wpm) throw new RangeError('CW speed requires 3 ≤ effective WPM ≤ character WPM ≤ 80.');
    this.dotMs = 1200 / wpm;
    const spacingDotMs = (60000 / farnsworthWpm - 31 * this.dotMs) / 19;
    this.letterGapMs = (this.dotMs + 3 * spacingDotMs) / 2;
    this.wordGapMs = 5 * spacingDotMs;
  }
  get decoded(): string { return this.text; }
  get pending(): string { return this.code; }
  reset(): void { this.code = this.text = ''; this.lastUp = this.downAt = null; this.emittedSpace = false; }
  private commit(): void { if (this.code) { this.text += REVERSE_MORSE[this.code] ?? '�'; this.code = ''; } }
  /** Time is monotonic milliseconds; bounces shorter than 0.2 dots are discarded. */
  key(down: boolean, timestamp: number): string {
    if (!Number.isFinite(timestamp) || timestamp < 0) throw new RangeError('Key timestamp must be nonnegative milliseconds.');
    if ((this.lastUp !== null && timestamp < this.lastUp) || (this.downAt !== null && timestamp < this.downAt)) throw new RangeError('Key timestamps must increase.');
    if (down && this.downAt === null) {
      this.tick(timestamp); this.downAt = timestamp; this.emittedSpace = false;
    } else if (!down && this.downAt !== null) {
      const length = timestamp - this.downAt;
      if (length < 0) throw new RangeError('Key timestamps must increase.');
      if (length >= this.dotMs * 0.2) this.code += length < this.dotMs * 2 ? '.' : '-';
      this.downAt = null; this.lastUp = timestamp;
    }
    return this.text;
  }
  tick(timestamp: number): string {
    if (!Number.isFinite(timestamp) || timestamp < 0 || (this.lastUp !== null && timestamp < this.lastUp)) throw new RangeError('Key timestamps must increase.');
    if (this.lastUp !== null && this.downAt === null) {
      const gap = timestamp - this.lastUp;
      if (gap >= this.letterGapMs) this.commit();
      if (gap >= this.wordGapMs && this.text && !this.emittedSpace) { this.text += ' '; this.emittedSpace = true; }
    }
    return this.text;
  }
  finish(): string { this.commit(); return this.text.trim(); }
}

/** Offline single-tone CW decoder, for stable known-speed input. Not a general weak-signal decoder. */
export function decodeCwAudio(samples: Float32Array, sampleRate: number, options: CwAudioOptions = {}): string {
  const tone = options.toneHz ?? 700;
  if (sampleRate <= 0 || tone <= 0 || tone >= sampleRate / 2) throw new RangeError('CW decoder tone must be below Nyquist.');
  const filter = new BiquadFilter(biquadCoefficients('bandpass', tone, sampleRate, 8));
  const hop = Math.max(1, Math.round(sampleRate * 0.005)), levels: number[] = [];
  for (let offset = 0; offset < samples.length; offset += hop) {
    let energy = 0;
    for (let i = offset; i < Math.min(samples.length, offset + hop); i++) { const value = filter.process(samples[i]); energy += value * value; }
    levels.push(Math.sqrt(energy / hop));
  }
  const maximum = levels.reduce((max, value) => Math.max(max, value), 0);
  if (maximum < 1e-5) return '';
  const decoder = new MorseKeyDecoder(options.wpm ?? 20, options.farnsworthWpm ?? options.wpm ?? 20); let down = false;
  for (let i = 0; i < levels.length; i++) {
    const next: boolean = levels[i] > maximum * (down ? 0.2 : 0.3);
    const time = (i + 0.5) * hop / sampleRate * 1000;
    if (next !== down) { decoder.key(next, time); down = next; }
    if (!down) decoder.tick(time);
  }
  if (down) decoder.key(false, samples.length / sampleRate * 1000);
  return decoder.finish();
}
