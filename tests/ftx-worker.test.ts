import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { decodeWav } from '../src/audio/wav.ts';

function waitMessage(worker: Worker, accept: (message: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', failure); };
    const message = (value: any) => { if (value.type === 'fatal') { cleanup(); reject(new Error(value.error)); } else if (accept(value)) { cleanup(); resolve(value); } };
    const failure = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('FTX worker test timed out.')); }, 10000);
    worker.on('message', message); worker.on('error', failure);
  });
}

test('minified embedded FTX worker instantiates WASM and transfers authentic PCM/results', async () => {
  const wasm = await readFile(new URL('../wasm/ftx.wasm', import.meta.url));
  const bundle = await build({ entryPoints: ['src/digital/ftx/worker.ts'], bundle: true, write: false, format: 'iife', target: 'es2022', minify: true, define: { __RADIODESK_FTX_WASM__: JSON.stringify(wasm.toString('base64')) } });
  // Adapt Node's worker transport to the browser worker's two global message hooks.
  const transport = `const {parentPort} = require('node:worker_threads'); globalThis.postMessage=(value, transfer)=>parentPort.postMessage(value, transfer); parentPort.on('message', data=>globalThis.onmessage({data}));`;
  const worker = new Worker(transport + bundle.outputFiles[0].text, { eval: true });
  try {
    await waitMessage(worker, message => message.type === 'ready');
    const encodedPromise = waitMessage(worker, message => message.id === 1);
    worker.postMessage({ id: 1, operation: 'encode', message: 'CQ K1ABC FN42', mode: 'FT4', options: { volume: 0.2 } });
    const encoded = await encodedPromise;
    assert.equal(encoded.error, undefined);
    assert.equal(encoded.result.samples.length, 60480);
    assert.equal(encoded.result.wav.byteLength, 180044);
    assert.equal(encoded.result.tones.length, 105);
    const source = await readFile(new URL('../vendor/ft8_lib/test/wav/wsjtx-ft4-000000_000002.wav', import.meta.url));
    const wav = decodeWav(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
    const buffer = wav.samples.buffer as ArrayBuffer;
    const decodedPromise = waitMessage(worker, message => message.id === 2);
    worker.postMessage({ id: 2, operation: 'decode', buffer, sampleRate: wav.sampleRate, mode: 'FT4' }, [buffer]);
    assert.equal(buffer.byteLength, 0, 'Receive buffer is transferred rather than copied by the worker transport.');
    const decoded = await decodedPromise;
    assert.equal(decoded.error, undefined);
    assert.ok(decoded.result.some((message: { text: string }) => message.text === 'WD9IGY KX1X 73'));
  } finally { await worker.terminate(); }
});
