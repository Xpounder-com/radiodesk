import type { CwAudioOptions } from './morse.ts';
import type { RttyOptions } from './rtty.ts';
import type { DigitalDecodeRequest, DigitalDecodeResponse } from './decoder-worker.ts';

/** Injected by the build after separately bundling the complete decoder worker. */
declare const __RADIO_DESK_DECODER_WORKER__: string;

export function decodeDigitalWav(mode: 'cw', buffer: ArrayBuffer, options: CwAudioOptions): Promise<string>;
export function decodeDigitalWav(mode: 'rtty', buffer: ArrayBuffer, options: RttyOptions): Promise<string>;
/** The ArrayBuffer is transferred to a disposable worker; it becomes detached. */
export function decodeDigitalWav(mode: 'cw' | 'rtty', buffer: ArrayBuffer, options: CwAudioOptions | RttyOptions): Promise<string> {
  if (buffer.byteLength > 32 * 1024 * 1024) return Promise.reject(new Error('For offline digital decoding, import a WAV smaller than 32 MB.'));
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null, url: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (result: string | null, error?: Error): void => {
      if (settled) return; settled = true;
      if (timer !== null) clearTimeout(timer);
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      if (error) reject(error); else resolve(result ?? '');
    };
    try {
      url = URL.createObjectURL(new Blob([__RADIO_DESK_DECODER_WORKER__], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (event: MessageEvent<DigitalDecodeResponse>) => {
        if (event.data && 'result' in event.data && typeof event.data.result === 'string') finish(event.data.result);
        else if (event.data && 'error' in event.data && typeof event.data.error === 'string') finish(null, new Error(event.data.error));
        else finish(null, new Error('The digital decoder returned an invalid response.'));
      };
      worker.onerror = event => { event.preventDefault(); finish(null, new Error(event.message || 'The digital decoder worker failed.')); };
      worker.onmessageerror = () => finish(null, new Error('Could not receive the digital decoder result.'));
      timer = setTimeout(() => finish(null, new Error('Digital decoding exceeded 90 seconds. Use a shorter WAV recording.')), 90000);
      const request = { mode, buffer, options } as DigitalDecodeRequest;
      worker.postMessage(request, [buffer]);
    } catch (error) { finish(null, error instanceof Error ? error : new Error('Could not start the digital decoder worker.')); }
  });
}
