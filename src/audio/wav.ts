export interface WavAudio { samples: Float32Array; sampleRate: number; channels: number; duration: number; bitsPerSample: number }

/** Encode mono signed PCM16; clipped full-scale values map to the integer range. */
export function encodeWav(samples: Float32Array, sampleRate = 48000): ArrayBuffer {
  if (!Number.isInteger(sampleRate) || sampleRate < 1000 || sampleRate > 768000) throw new RangeError('Invalid WAV sample rate.');
  if (samples.length > (0xffffffff - 36) / 2) throw new RangeError('Recording is too large for RIFF WAV.');
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const write = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

/** Decode RIFF PCM 8/16/24/32 or IEEE float32 WAV; multichannel audio is averaged to mono. */
export function decodeWav(buffer: ArrayBuffer): WavAudio {
  const view = new DataView(buffer);
  const id = (offset: number) => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (buffer.byteLength < 12 || id(0) !== 'RIFF' || id(8) !== 'WAVE') throw new Error('This file is not a RIFF WAV recording.');
  const riffEnd = view.getUint32(4, true) + 8;
  if (riffEnd > buffer.byteLength || riffEnd < 12) throw new Error('WAV RIFF length is invalid or truncated.');
  let format = 0, channels = 0, sampleRate = 0, bits = 0, align = 0, dataOffset = -1, dataSize = 0;
  for (let offset = 12; offset + 8 <= riffEnd;) {
    const chunk = id(offset), size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size > riffEnd) throw new Error('WAV contains a truncated chunk.');
    if (chunk === 'fmt ') {
      if (size < 16) throw new Error('WAV format chunk is incomplete.');
      format = view.getUint16(start, true); channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true); align = view.getUint16(start + 12, true); bits = view.getUint16(start + 14, true);
      if (format === 0xfffe && size >= 40) {
        // Standard extensible PCM / float GUID; reject unrelated codecs.
        const tail = [0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        const extensionBytes = view.getUint16(start + 16, true), validBits = view.getUint16(start + 18, true);
        if (extensionBytes < 22 || (validBits !== 0 && validBits !== bits) || !tail.every((value, index) => view.getUint8(start + 26 + index) === value)) throw new Error('Unsupported extensible WAV format.');
        format = view.getUint16(start + 24, true);
      }
    } else if (chunk === 'data' && dataOffset < 0) { dataOffset = start; dataSize = size; }
    offset = start + size + (size & 1);
  }
  if (dataOffset < 0 || !channels || channels > 64 || sampleRate < 1000 || sampleRate > 768000) throw new Error('WAV is missing valid audio metadata.');
  if ((format !== 1 || ![8, 16, 24, 32].includes(bits)) && !(format === 3 && bits === 32)) throw new Error('Supported WAV formats: PCM 8/16/24/32 and float32.');
  const bytes = bits / 8;
  if (align !== channels * bytes || dataSize % align !== 0) throw new Error('WAV audio block alignment is invalid.');
  const samples = new Float32Array(dataSize / align);
  for (let frame = 0; frame < samples.length; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const offset = dataOffset + frame * align + channel * bytes;
      let value: number;
      if (format === 3) value = view.getFloat32(offset, true);
      else if (bits === 8) value = (view.getUint8(offset) - 128) / 128;
      else if (bits === 16) value = view.getInt16(offset, true) / 32768;
      else if (bits === 24) { let raw = view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getUint8(offset + 2) << 16; if (raw & 0x800000) raw -= 0x1000000; value = raw / 8388608; }
      else value = view.getInt32(offset, true) / 2147483648;
      sum += Number.isFinite(value) ? value : 0;
    }
    samples[frame] = sum / channels;
  }
  return { samples, sampleRate, channels, duration: samples.length / sampleRate, bitsPerSample: bits };
}
