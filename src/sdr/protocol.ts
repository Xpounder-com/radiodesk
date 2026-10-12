export interface RtlTcpHeader { magic: 'RTL0'; tunerType: number; tunerName: string; tunerGainCount: number }
const TUNER_NAMES = ['Unknown', 'E4000', 'FC0012', 'FC0013', 'FC2580', 'R820T', 'R828D'];

/** rtl_tcp's 12-byte network-endian preamble; it may be split across transport messages. */
export class RtlTcpParser {
  private preamble = new Uint8Array(12);
  private used = 0;
  header: RtlTcpHeader | null = null;
  push(bytes: Uint8Array): { header: RtlTcpHeader | null; iq: Uint8Array } {
    if (this.header) return { header: null, iq: bytes };
    const count = Math.min(12 - this.used, bytes.length);
    this.preamble.set(bytes.subarray(0, count), this.used); this.used += count;
    if (this.used < 12) return { header: null, iq: new Uint8Array(0) };
    if (String.fromCharCode(...this.preamble.subarray(0, 4)) !== 'RTL0') throw new Error('Expected the RTL0 rtl_tcp header. This endpoint is not a compatible IQ receiver.');
    const view = new DataView(this.preamble.buffer);
    const tunerType = view.getUint32(4, false), tunerGainCount = view.getUint32(8, false);
    if (tunerGainCount > 10000) throw new Error('Invalid rtl_tcp tuner gain count.');
    this.header = { magic: 'RTL0', tunerType, tunerName: TUNER_NAMES[tunerType] ?? `Tuner ${tunerType}`, tunerGainCount };
    return { header: this.header, iq: bytes.subarray(count) };
  }
}

/** A five-byte opcode and big-endian uint32/signed-int32 parameter. */
export function rtlCommand(command: 'frequency' | 'sampleRate' | 'gainMode' | 'gain' | 'ppm', value: number): Uint8Array {
  const codes = { frequency: 1, sampleRate: 2, gainMode: 3, gain: 4, ppm: 5 };
  if (!Object.hasOwn(codes, command)) throw new RangeError('Unsupported rtl_tcp receive command.');
  if (!Number.isInteger(value)) throw new RangeError('rtl_tcp command values must be integers.');
  const signed = command === 'gain' || command === 'ppm';
  if (signed ? value < -2147483648 || value > 2147483647 : value < 0 || value > 0xffffffff) throw new RangeError('rtl_tcp parameter is out of its 32-bit range.');
  if (command === 'gainMode' && value !== 0 && value !== 1) throw new RangeError('Gain mode must be automatic (0) or manual (1).');
  const frame = new Uint8Array(5), view = new DataView(frame.buffer);
  frame[0] = codes[command];
  if (signed) view.setInt32(1, value, false); else view.setUint32(1, value, false);
  return frame;
}

/** Preserve I/Q alignment even when a TCP/WS chunk ends after an I byte. */
export class U8IqDecoder {
  private pendingI: number | null = null;
  decode(bytes: Uint8Array): Float32Array {
    const count = Math.floor((bytes.length + (this.pendingI === null ? 0 : 1)) / 2);
    const result = new Float32Array(count * 2);
    let source = 0, target = 0;
    if (this.pendingI !== null && bytes.length > 0) {
      result[target++] = (this.pendingI - 127.5) / 128;
      result[target++] = (bytes[source++]! - 127.5) / 128;
      this.pendingI = null;
    }
    while (source + 1 < bytes.length) {
      result[target++] = (bytes[source++]! - 127.5) / 128;
      result[target++] = (bytes[source++]! - 127.5) / 128;
    }
    if (source < bytes.length) this.pendingI = bytes[source]!;
    return result;
  }
  reset(): void { this.pendingI = null; }
  get hasTrailingI(): boolean { return this.pendingI !== null; }
}
