import { encodeWav } from '../audio/wav.ts';

const LETTERS = ['\0', 'E', '\n', 'A', ' ', 'S', 'I', 'U', '\r', 'D', 'R', 'J', 'N', 'F', 'C', 'K', 'T', 'Z', 'L', 'W', 'H', 'Y', 'P', 'Q', 'O', 'B', 'G', '', 'M', 'X', 'V', ''];
// International ITA2: national/private FIGS assignments (F, G, H) intentionally absent.
const FIGURES = ['\0', '3', '\n', '-', ' ', "'", '8', '7', '\r', '', '4', '\x07', ',', '', ':', '(', '5', '+', ')', '2', '', '6', '0', '1', '9', '?', '', '', '.', '/', '=', ''];
export const BAUDOT_FIGURES_SHIFT = 27;
export const BAUDOT_LETTERS_SHIFT = 31;

export function encodeBaudot(text: string): number[] {
  let figures = false; const result = [BAUDOT_LETTERS_SHIFT];
  for (const character of text.toUpperCase()) {
    let value = (figures ? FIGURES : LETTERS).indexOf(character);
    if (value < 0) {
      value = (figures ? LETTERS : FIGURES).indexOf(character);
      if (value < 0 || character === '\0') throw new Error(`Unsupported international ITA2 character: ${character}`);
      figures = !figures; result.push(figures ? BAUDOT_FIGURES_SHIFT : BAUDOT_LETTERS_SHIFT);
    }
    result.push(value);
  }
  return result;
}

export function decodeBaudot(codes: readonly number[]): string {
  let figures = false, text = '';
  for (const code of codes) {
    if (!Number.isInteger(code) || code < 0 || code > 31) throw new RangeError('Baudot words contain five bits.');
    if (code === BAUDOT_FIGURES_SHIFT) figures = true;
    else if (code === BAUDOT_LETTERS_SHIFT) figures = false;
    else if (code !== 0) text += (figures ? FIGURES : LETTERS)[code] || '�';
  }
  return text;
}

export interface RttyOptions { baud?: number; markHz?: number; shiftHz?: number; sampleRate?: number; volume?: number; reverse?: boolean }
export interface RttyElement { mark: boolean; units: number }

/** One SPACE start, five data bits LSB-first, 1.5 MARK stop. */
export function rttyTiming(text: string): RttyElement[] {
  const elements: RttyElement[] = [{ mark: true, units: 10 }];
  for (const code of encodeBaudot(text)) {
    elements.push({ mark: false, units: 1 });
    for (let bit = 0; bit < 5; bit++) elements.push({ mark: Boolean(code & (1 << bit)), units: 1 });
    elements.push({ mark: true, units: 1.5 });
  }
  elements.push({ mark: true, units: 10 }); return elements;
}

function settings(options: RttyOptions, sampleRate: number): { baud: number; mark: number; space: number; volume: number } {
  const baud = options.baud ?? 45.45, mark = options.markHz ?? 2125, space = mark + (options.shiftHz ?? 170), volume = options.volume ?? 0.35;
  if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 768000 || !Number.isFinite(baud) || baud < 10 || baud > 300 || !Number.isFinite(mark) || !Number.isFinite(space) || mark < 100 || space <= mark || space >= sampleRate / 2 || !Number.isFinite(volume) || volume < 0 || volume > 1) throw new RangeError('Invalid RTTY baud, frequencies, sample rate, or volume.');
  return { baud, mark: options.reverse ? space : mark, space: options.reverse ? mark : space, volume };
}

/** Phase-continuous audio FSK practice waveform; this does not key a transmitter. */
export function generateRttyWav(text: string, options: RttyOptions = {}): ArrayBuffer {
  const sampleRate = options.sampleRate ?? 48000, config = settings(options, sampleRate), elements = rttyTiming(text);
  const total = elements.reduce((sum, element) => sum + element.units, 0) / config.baud;
  if (total > 600) throw new RangeError('Practice audio is limited to ten minutes.');
  const samples = new Float32Array(Math.ceil(total * sampleRate));
  let position = 0, elapsedUnits = 0, phase = 0;
  for (const element of elements) {
    elapsedUnits += element.units;
    const end = Math.round(elapsedUnits / config.baud * sampleRate), frequency = element.mark ? config.mark : config.space;
    while (position < end && position < samples.length) {
      samples[position++] = config.volume * Math.sin(phase);
      phase = (phase + 2 * Math.PI * frequency / sampleRate) % (2 * Math.PI);
    }
  }
  // Smooth only the beginning and end, preserving asynchronous bit transitions.
  const ramp = Math.min(Math.round(sampleRate * 0.005), Math.floor(samples.length / 2));
  for (let i = 0; i < ramp; i++) { const envelope = 0.5 - 0.5 * Math.cos(Math.PI * i / ramp); samples[i] *= envelope; samples[samples.length - 1 - i] *= envelope; }
  return encodeWav(samples, sampleRate);
}

/** Offline two-tone ITA2 demodulator with fixed baud and shift. Clean audio validation only. */
export function decodeRttyAudio(samples: Float32Array, sampleRate: number, options: RttyOptions = {}): string {
  const config = settings(options, sampleRate), bitSamples = sampleRate / config.baud;
  function energy(center: number, frequency: number, fraction = 0.65): number {
    const count = Math.max(8, Math.round(bitSamples * fraction));
    const start = Math.round(center - count / 2), omega = 2 * Math.PI * frequency / sampleRate, coefficient = 2 * Math.cos(omega);
    let previous = 0, earlier = 0;
    for (let i = 0; i < count; i++) {
      const index = start + i;
      const sample = index < 0 || index >= samples.length ? 0 : samples[index];
      const current = sample * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (count - 1))) + coefficient * previous - earlier;
      earlier = previous; previous = current;
    }
    return previous * previous + earlier * earlier - coefficient * previous * earlier;
  }
  function isMark(center: number, fraction = 0.65): boolean { return energy(center, config.mark, fraction) > energy(center, config.space, fraction); }
  const codes: number[] = [], step = Math.max(1, bitSamples / 8);
  let armed = false;
  for (let position = bitSamples / 2; position + 7 * bitSamples < samples.length; position += step) {
    if (isMark(position, 0.35)) { armed = true; continue; }
    if (!armed) continue;
    // The scanner finds the leading edge within 1/8 bit; validate middle of start and stop.
    const start = position - 0.125 * bitSamples;
    if (isMark(start + 0.5 * bitSamples) || !isMark(start + 6.5 * bitSamples)) { armed = false; continue; }
    let code = 0;
    for (let bit = 0; bit < 5; bit++) if (isMark(start + (1.5 + bit) * bitSamples)) code |= 1 << bit;
    codes.push(code); position = start + 6.9 * bitSamples; armed = true;
  }
  return decodeBaudot(codes);
}
