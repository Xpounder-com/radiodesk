import { decodeWav } from '../audio/wav.ts';
import { decodeCwAudio, type CwAudioOptions } from './morse.ts';
import { decodeRttyAudio, type RttyOptions } from './rtty.ts';

export type DigitalDecodeRequest =
  | { mode: 'cw'; options: CwAudioOptions; buffer: ArrayBuffer }
  | { mode: 'rtty'; options: RttyOptions; buffer: ArrayBuffer };

export type DigitalDecodeResponse = { result: string } | { error: string };

const scope = globalThis as unknown as {
  onmessage: (event: { data: DigitalDecodeRequest }) => void;
  postMessage: (response: DigitalDecodeResponse) => void;
};

scope.onmessage = event => {
  try {
    const request = event.data;
    if (!request || !(request.buffer instanceof ArrayBuffer)) throw new Error('A WAV ArrayBuffer is required for digital decoding.');
    if (request.buffer.byteLength > 32 * 1024 * 1024) throw new Error('For offline digital decoding, import a WAV smaller than 32 MB.');
    if (request.mode !== 'cw' && request.mode !== 'rtty') throw new Error('Unsupported digital decoder mode.');
    const audio = decodeWav(request.buffer);
    if (audio.duration > 120) throw new Error('For offline digital decoding, use a recording shorter than two minutes.');
    const result = request.mode === 'cw'
      ? decodeCwAudio(audio.samples, audio.sampleRate, request.options)
      : decodeRttyAudio(audio.samples, audio.sampleRate, request.options);
    scope.postMessage({ result });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : 'Could not decode the WAV recording.' });
  }
};
