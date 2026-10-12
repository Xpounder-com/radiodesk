import test from 'node:test';
import assert from 'node:assert/strict';
import { SignalEngine } from '../src/audio/engine.ts';
import { encodeWav } from '../src/audio/wav.ts';

for (const phase of ['worklet', 'resume'] as const) {
  test(`stopping an audible WAV during pending ${phase} preparation prevents later playback`, async () => {
    let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    let closes = 0, resumes = 0, sources = 0;
    class Context {
      sampleRate = 48000;
      currentTime = 0;
      audioWorklet = { addModule: () => phase === 'worklet' ? pending : Promise.resolve() };
      async resume(): Promise<void> { resumes++; if (phase === 'resume') await pending; }
      async close(): Promise<void> { closes++; }
      createBufferSource(): never { sources++; throw new Error('Canceled source must not be created'); }
    }
    const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
    Object.defineProperty(globalThis, 'AudioContext', { value: Context, configurable: true });
    const engine = new SignalEngine();
    try {
      const start = engine.importWav(encodeWav(new Float32Array(4800), 48000));
      const canceled = assert.rejects(start, /cancelled/);
      await new Promise(resolve => setImmediate(resolve));
      if (phase === 'resume') assert.equal(resumes, 1);
      engine.stop(); assert.ok(closes > 0, 'pending context closes immediately');
      complete(); await canceled;
      assert.equal(sources, 0); assert.equal(engine.source, 'Stopped');
    } finally {
      engine.stop();
      if (original) Object.defineProperty(globalThis, 'AudioContext', original);
      else Reflect.deleteProperty(globalThis, 'AudioContext');
    }
  });
}
