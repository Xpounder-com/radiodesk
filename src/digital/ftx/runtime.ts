import { encodeWav } from '../../audio/wav.ts';
import { FTX_PROTOCOL, type FtxMode, type FtxEncodeOptions, type EncodedTransmission, type FtxDecodeResult } from './types.ts';

interface FtxWasmExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(bytes: number): number;
  free(pointer: number): void;
  rd_reset(): void;
  rd_encode(text: number, mode: number, freeText: number, payload: number, tones: number, normalized: number): number;
  rd_synthesize(tones: number, mode: number, audioHz: number, sampleRate: number, volume: number, output: number): number;
  rd_decode(samples: number, count: number, mode: number): number;
  rd_result_text(index: number): number;
  rd_result_frequency(index: number): number;
  rd_result_time(index: number): number;
  rd_result_score(index: number): number;
}

/** Bandlimited polyphase windowed-sinc conversion for 6–192 kHz receive audio. */
export function resampleForFtx(samples: Float32Array, sampleRate: number): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate < 6000 || sampleRate > 192000) throw new RangeError('FT8/FT4 receive audio requires a sample rate from 6 to 192 kHz.');
  if (samples.length > sampleRate * 120) throw new RangeError('FT8/FT4 decode accepts at most two minutes of audio per job.');
  if (sampleRate === 12000) return Float32Array.from(samples, value => Number.isFinite(value) ? value : 0);
  const count = Math.floor(samples.length * 12000 / sampleRate), output = new Float32Array(count);
  const radius = Math.ceil(16 * Math.max(1, sampleRate / 12000)), taps = radius * 2, phases = 256;
  const cutoff = Math.min(1, 12000 / sampleRate) * 0.88;
  const coefficients = new Float64Array(phases * taps);
  for (let phase = 0; phase < phases; phase++) {
    let weightSum = 0;
    for (let tap = 0; tap < taps; tap++) {
      const distance = phase / phases - (tap - radius + 1), z = Math.PI * cutoff * distance;
      const sinc = Math.abs(z) < 1e-10 ? cutoff : cutoff * Math.sin(z) / z;
      const weight = sinc * (0.5 + 0.5 * Math.cos(Math.PI * distance / radius));
      coefficients[phase * taps + tap] = weight; weightSum += weight;
    }
    for (let tap = 0; tap < taps; tap++) coefficients[phase * taps + tap] /= weightSum;
  }
  for (let i = 0; i < count; i++) {
    const position = i * sampleRate / 12000, center = Math.floor(position);
    const phase = Math.min(phases - 1, Math.floor((position - center) * phases));
    let sum = 0, weightSum = 0;
    for (let tap = 0; tap < taps; tap++) {
      const index = center - radius + 1 + tap, weight = coefficients[phase * taps + tap];
      if (index >= 0 && index < samples.length) { sum += (Number.isFinite(samples[index]) ? samples[index] : 0) * weight; weightSum += weight; }
    }
    output[i] = Math.abs(weightSum) > 1e-10 ? sum / weightSum : 0;
  }
  return output;
}

export async function instantiateFtx(bytes: Uint8Array): Promise<FtxRuntime> {
  let exports: FtxWasmExports;
  const imports = {
    env: { emscripten_notify_memory_growth: () => {} },
    wasi_snapshot_preview1: {
      proc_exit: (code: number) => { throw new Error(`FT8/FT4 modem exited with status ${code}.`); },
      fd_close: () => 0,
      fd_seek: () => 8,
      fd_write: (_fd: number, vectors: number, count: number, written: number) => {
        const view = new DataView(exports.memory.buffer); let length = 0;
        for (let i = 0; i < count; i++) length += view.getUint32(vectors + i * 8 + 4, true);
        view.setUint32(written, length, true); return 0;
      },
    },
  };
  const module = await WebAssembly.instantiate(new Uint8Array(bytes), imports);
  exports = module.instance.exports as unknown as FtxWasmExports;
  exports._initialize(); exports.rd_reset(); return new FtxRuntime(exports);
}

/** Direct runtime is used inside the dedicated browser worker and by binary regression tests. */
export class FtxRuntime {
  private wasm: FtxWasmExports;
  constructor(wasm: FtxWasmExports) { this.wasm = wasm; }
  private allocate(bytes: number): number { const pointer = this.wasm.malloc(bytes); if (!pointer) throw new Error('FT8/FT4 modem ran out of memory.'); return pointer; }
  private string(pointer: number): string {
    const bytes = new Uint8Array(this.wasm.memory.buffer); let end = pointer;
    while (end < bytes.length && bytes[end] !== 0 && end < pointer + 256) end++;
    return new TextDecoder().decode(bytes.subarray(pointer, end));
  }
  reset(): void { this.wasm.rd_reset(); }

  encode(message: string, mode: FtxMode, options: FtxEncodeOptions = {}): EncodedTransmission {
    const protocol = FTX_PROTOCOL[mode]; if (!protocol) throw new Error('Mode must be FT8 or FT4.');
    const normalized = message.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!normalized || normalized.length > 34 || !/^[A-Z0-9 +\-./?<>]+$/.test(normalized)) throw new Error('Use a supported standard FT8/FT4 message or up to 13 free-text characters (A–Z, 0–9, space, + - . / ?).');
    if (options.freeText && (normalized.length > 13 || !/^[A-Z0-9 +\-./?]+$/.test(normalized))) throw new Error('FT8/FT4 free text has at most 13 characters from A–Z, 0–9, space, + - . / ?.');
    const sampleRate = options.sampleRate ?? 12000, audioHz = options.audioHz ?? 1000, volume = options.volume ?? 0.2;
    if (![12000, 24000, 48000].includes(sampleRate) || !Number.isFinite(volume) || volume < 0 || volume > 1 || !Number.isFinite(audioHz) || audioHz < 200 || audioHz + (mode === 'FT8' ? 7 : 3) * protocol.toneSpacingHz > 3000) throw new RangeError('Use 12, 24 or 48 kHz audio, volume 0–1, and a complete tone set within 200–3000 Hz.');
    const pointers: number[] = [];
    try {
      const alloc = (size: number) => { const pointer = this.allocate(size); pointers.push(pointer); return pointer; };
      const text = alloc(128), payload = alloc(10), tones = alloc(105), decodedText = alloc(128);
      const utf8 = new TextEncoder().encode(normalized + '\0'); new Uint8Array(this.wasm.memory.buffer, text, utf8.length).set(utf8);
      const count = this.wasm.rd_encode(text, mode === 'FT4' ? 4 : 8, Number(Boolean(options.freeText)), payload, tones, decodedText);
      if (count < 0) throw new Error(`The upstream modem cannot pack this message (code ${count}). Use CQ CALL GRID, CALL CALL REPORT / RRR / RR73 / 73, or explicit free text.`);
      const packedMessage = this.string(decodedText).trim().replace(/\s+/g, ' ');
      if (packedMessage !== normalized) throw new Error(`The packed message would decode as "${packedMessage}". Revise the message before generating transmit audio.`);
      const payloadBytes = new Uint8Array(this.wasm.memory.buffer, payload, 10).slice(), toneBytes = new Uint8Array(this.wasm.memory.buffer, tones, count).slice();
      const signalCount = Math.round(count * protocol.symbolSeconds * sampleRate), signalPointer = alloc(signalCount * 4);
      const written = this.wasm.rd_synthesize(tones, mode === 'FT4' ? 4 : 8, audioHz, sampleRate, volume, signalPointer);
      if (written !== signalCount) throw new Error('The modem returned an invalid waveform length.');
      const samples = new Float32Array(this.wasm.memory.buffer, signalPointer, written).slice();
      const slotSamples = new Float32Array(Math.round(protocol.slotSeconds * sampleRate));
      slotSamples.set(samples, Math.round(protocol.startDelaySeconds * sampleRate));
      return { message: packedMessage, mode, samples, sampleRate, tones: toneBytes, payload: payloadBytes, wav: encodeWav(slotSamples, sampleRate), slotSeconds: protocol.slotSeconds, signalSeconds: signalCount / sampleRate, startDelaySeconds: protocol.startDelaySeconds };
    } finally { for (const pointer of pointers) this.wasm.free(pointer); }
  }

  decode(samples: Float32Array, sampleRate: number, mode: FtxMode): FtxDecodeResult[] {
    const protocol = FTX_PROTOCOL[mode]; if (!protocol) throw new Error('Mode must be FT8 or FT4.');
    const audio = resampleForFtx(samples, sampleRate), slotSamples = Math.round(protocol.slotSeconds * 12000), results: FtxDecodeResult[] = [];
    for (let offset = 0; offset < audio.length; offset += slotSamples) {
      const block = audio.subarray(offset, Math.min(audio.length, offset + slotSamples));
      if (block.length < protocol.symbolSeconds * protocol.symbols * 12000 * 0.9) continue;
      const pointer = this.allocate(block.length * 4);
      try {
        new Float32Array(this.wasm.memory.buffer, pointer, block.length).set(block);
        const count = this.wasm.rd_decode(pointer, block.length, mode === 'FT4' ? 4 : 8);
        if (count < 0) throw new Error(`The modem rejected this receive frame (code ${count}).`);
        for (let i = 0; i < count; i++) results.push({ text: this.string(this.wasm.rd_result_text(i)), mode, audioHz: this.wasm.rd_result_frequency(i), timeOffsetSeconds: this.wasm.rd_result_time(i) - protocol.symbolSeconds + offset / 12000, syncScore: this.wasm.rd_result_score(i) });
      } finally { this.wasm.free(pointer); }
    }
    return results;
  }
}
