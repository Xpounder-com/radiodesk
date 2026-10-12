import type { FtxModem, FtxMode, FtxEncodeOptions, EncodedTransmission, FtxDecodeResult } from './types.ts';
export type { FtxModem, FtxMode, FtxEncodeOptions, EncodedTransmission, FtxDecodeResult } from './types.ts';
export { FTX_PROTOCOL } from './types.ts';

declare const __RADIODESK_FTX_WORKER__: string;

/** Creates a persistent local worker. No network access or radio control is performed. */
export async function createFtxModem(): Promise<FtxModem> {
  const url = URL.createObjectURL(new Blob([__RADIODESK_FTX_WORKER__], { type: 'text/javascript' }));
  let worker: Worker;
  try { worker = new Worker(url); } catch (error) { URL.revokeObjectURL(url); throw error; }
  URL.revokeObjectURL(url);
  let closed = false, nextId = 1;
  type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  const pending = new Map<number, Pending>();
  const failAll = (error: Error) => { if (closed) return; closed = true; worker.terminate(); for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); } pending.clear(); };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { failAll(new Error('FT8/FT4 modem initialization timed out.')); reject(new Error('FT8/FT4 modem initialization timed out.')); }, 30000);
    worker.onerror = event => { clearTimeout(timer); event.preventDefault(); const error = new Error(event.message || 'FT8/FT4 worker failed.'); failAll(error); reject(error); };
    worker.onmessage = event => {
      if (event.data.type === 'ready') { clearTimeout(timer); resolve(); }
      else if (event.data.type === 'fatal') { clearTimeout(timer); const error = new Error(event.data.error); failAll(error); reject(error); }
    };
  });
  worker.onerror = event => { event.preventDefault(); failAll(new Error(event.message || 'FT8/FT4 worker failed.')); };
  worker.onmessageerror = () => failAll(new Error('Could not read FT8/FT4 worker results.'));
  worker.onmessage = event => {
    const job = pending.get(event.data.id); if (!job) return;
    pending.delete(event.data.id); clearTimeout(job.timer);
    if (event.data.error) job.reject(new Error(event.data.error)); else job.resolve(event.data.result);
  };
  const request = <T>(data: Record<string, unknown>, transfer: ArrayBuffer[] = []): Promise<T> => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('FT8/FT4 modem has been disposed.')); return; }
    const id = nextId++, timer = setTimeout(() => failAll(new Error('FT8/FT4 decode exceeded 90 seconds. Use a shorter recording.')), 90000);
    pending.set(id, { resolve, reject, timer });
    try { worker.postMessage({ id, ...data }, transfer); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
  return {
    encode: (message: string, mode: FtxMode, options?: FtxEncodeOptions) => request<EncodedTransmission>({ operation: 'encode', message, mode, options }),
    decode: (samples: Float32Array, sampleRate: number, mode: FtxMode) => {
      if (!Number.isFinite(sampleRate) || samples.length > sampleRate * 120) return Promise.reject(new Error('FT8/FT4 decode accepts at most two minutes of audio.'));
      const buffer = samples.slice().buffer as ArrayBuffer;
      return request<FtxDecodeResult[]>({ operation: 'decode', buffer, sampleRate, mode }, [buffer]);
    },
    reset: () => request<void>({ operation: 'reset' }),
    dispose: () => failAll(new Error('FT8/FT4 modem has been disposed.')),
  };
}
