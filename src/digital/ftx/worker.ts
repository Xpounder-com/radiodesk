import { instantiateFtx } from './runtime.ts';
import type { FtxMode, FtxEncodeOptions } from './types.ts';

declare const __RADIODESK_FTX_WASM__: string;
type Request = { id: number; operation: 'encode'; message: string; mode: FtxMode; options?: FtxEncodeOptions } | { id: number; operation: 'decode'; buffer: ArrayBuffer; sampleRate: number; mode: FtxMode } | { id: number; operation: 'reset' };
const scope = globalThis as unknown as { onmessage: (event: { data: Request }) => void; postMessage(message: unknown, transfer?: ArrayBuffer[]): void };

const ready = instantiateFtx(Uint8Array.from(atob(__RADIODESK_FTX_WASM__), character => character.charCodeAt(0)));
ready.then(() => scope.postMessage({ type: 'ready' })).catch((error: unknown) => scope.postMessage({ type: 'fatal', error: error instanceof Error ? error.message : 'Could not load FT8/FT4 WebAssembly.' }));
scope.onmessage = async event => {
  const request = event.data;
  try {
    const runtime = await ready;
    if (request.operation === 'encode') {
      const result = runtime.encode(request.message, request.mode, request.options);
      scope.postMessage({ id: request.id, result }, [result.samples.buffer as ArrayBuffer, result.tones.buffer as ArrayBuffer, result.payload.buffer as ArrayBuffer, result.wav]);
    } else if (request.operation === 'decode') scope.postMessage({ id: request.id, result: runtime.decode(new Float32Array(request.buffer), request.sampleRate, request.mode) });
    else if (request.operation === 'reset') { runtime.reset(); scope.postMessage({ id: request.id, result: null }); }
    else throw new Error('Unsupported FT8/FT4 worker operation.');
  } catch (error) { scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : 'FT8/FT4 operation failed.' }); }
};
