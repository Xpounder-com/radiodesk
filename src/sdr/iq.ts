import { U8IqDecoder } from './protocol.ts';

export interface IqFormat {
  kind: 'wav' | 'u8' | 's16le' | 'f32le';
  /** Required for raw IQ; WAV supplies its own sample rate. */
  sampleRate?: number;
  /** RF centre frequency metadata in Hz, supplied by the operator. */
  centerFrequency: number;
  loop?: boolean;
  fftSize?: number;
}
export interface IqRecording { iq: Float32Array; sampleRate: number; centerFrequency: number; sampleCount: number; duration: number; kind: IqFormat['kind'] }

export function validateSampleRate(rate: number): number {
  if (!Number.isInteger(rate) || rate < 8000 || rate > 3_200_000) throw new RangeError('IQ sample rate must be an integer between 8 kHz and 3.2 MHz.');
  return rate;
}
export function validateFrequency(frequency: number): number {
  if (!Number.isInteger(frequency) || frequency < 0 || frequency > 0xffffffff) throw new RangeError('RF frequency must be an integer from 0 to 4,294,967,295 Hz.');
  return frequency;
}

/** Stereo WAV preserves channel 0 as I and channel 1 as Q, never averages them. */
function wavIq(buffer: ArrayBuffer): { iq: Float32Array; sampleRate: number } {
  const view = new DataView(buffer);
  const id = (offset: number): string => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (buffer.byteLength < 12 || id(0) !== 'RIFF' || id(8) !== 'WAVE') throw new Error('IQ WAV must be a RIFF WAVE file.');
  const end = view.getUint32(4, true) + 8;
  if (end > buffer.byteLength || end < 12) throw new Error('IQ WAV is truncated.');
  let format = 0, channels = 0, sampleRate = 0, bits = 0, alignment = 0, data = -1, size = 0;
  for (let offset = 12; offset + 8 <= end;) {
    const name = id(offset), length = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + length > end) throw new Error('IQ WAV chunk exceeds RIFF length.');
    if (name === 'fmt ') {
      if (length < 16) throw new Error('IQ WAV format chunk is incomplete.');
      format = view.getUint16(start, true); channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true); alignment = view.getUint16(start + 12, true); bits = view.getUint16(start + 14, true);
      if (format === 0xfffe) {
        if (length < 40 || view.getUint16(start + 16, true) < 22) throw new Error('Unsupported extensible IQ WAV.');
        const guidTail = [0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        if (!guidTail.every((v, i) => view.getUint8(start + 26 + i) === v)) throw new Error('Unsupported IQ WAV codec GUID.');
        const validBits = view.getUint16(start + 18, true);
        if (validBits !== 0 && validBits !== bits) throw new Error('Packed valid-bit IQ WAV is not supported.');
        format = view.getUint16(start + 24, true);
      }
    } else if (name === 'data' && data < 0) { data = start; size = length; }
    offset = start + length + (length & 1);
  }
  if (channels !== 2) throw new Error('IQ WAV requires exactly two channels: I left, Q right. A mono receiver-audio WAV is not wideband IQ.');
  validateSampleRate(sampleRate);
  if (data < 0 || size === 0) throw new Error('IQ WAV has no data.');
  if (!(format === 1 && [8, 16, 24, 32].includes(bits)) && !(format === 3 && bits === 32)) throw new Error('IQ WAV supports PCM 8/16/24/32 or float32.');
  const bytes = bits / 8;
  if (alignment !== 2 * bytes || size % alignment !== 0) throw new Error('IQ WAV frame alignment is invalid.');
  const iq = new Float32Array(size / bytes);
  for (let i = 0; i < iq.length; i++) {
    const offset = data + i * bytes;
    let value: number;
    if (format === 3) value = view.getFloat32(offset, true);
    else if (bits === 8) value = (view.getUint8(offset) - 127.5) / 128;
    else if (bits === 16) value = view.getInt16(offset, true) / 32768;
    else if (bits === 24) { let integer = view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getUint8(offset + 2) << 16; if (integer & 0x800000) integer -= 0x1000000; value = integer / 8388608; }
    else value = view.getInt32(offset, true) / 2147483648;
    if (!Number.isFinite(value)) throw new Error('IQ WAV contains nonfinite float samples.');
    iq[i] = value;
  }
  return { iq, sampleRate };
}

/** Read bounded offline interleaved I,Q recordings with explicit format metadata. */
export function decodeIq(buffer: ArrayBuffer, format: IqFormat): IqRecording {
  if (buffer.byteLength === 0 || buffer.byteLength > 64 * 1024 * 1024) throw new RangeError('IQ files must contain data and fit the 64 MiB import limit.');
  validateFrequency(format.centerFrequency);
  let iq: Float32Array, sampleRate: number;
  if (format.kind === 'wav') ({ iq, sampleRate } = wavIq(buffer));
  else {
    sampleRate = validateSampleRate(format.sampleRate ?? NaN);
    const bytes = format.kind === 'u8' ? 1 : format.kind === 's16le' ? 2 : format.kind === 'f32le' ? 4 : 0;
    if (!bytes || buffer.byteLength % (bytes * 2) !== 0) throw new RangeError('Raw IQ must contain complete interleaved I,Q frames.');
    if (format.kind === 'u8') iq = new U8IqDecoder().decode(new Uint8Array(buffer));
    else {
      const view = new DataView(buffer); iq = new Float32Array(buffer.byteLength / bytes);
      for (let i = 0; i < iq.length; i++) {
        const value = bytes === 2 ? view.getInt16(i * 2, true) / 32768 : view.getFloat32(i * 4, true);
        if (!Number.isFinite(value)) throw new Error('Raw IQ contains nonfinite float samples.');
        iq[i] = value;
      }
    }
  }
  return { iq, sampleRate, centerFrequency: format.centerFrequency, sampleCount: iq.length / 2, duration: iq.length / 2 / sampleRate, kind: format.kind };
}
