import { IqDemodulator } from './demod.ts';
import type { DemodulationOptions } from './demod.ts';
import { analyzeIqSpectrum } from './spectrum.ts';

let sampleRate = 2_048_000, centerFrequency = 100_000_000, fftSize = 4096;
let ring = new Float32Array(fftSize * 2), ringIndex = 0, received = 0, sinceFrame = 0;
let demodulation: DemodulationOptions = { mode: 'AM', offsetHz: 0, bandwidthHz: 10000 };
let demodulator = new IqDemodulator(sampleRate, demodulation);
let source = 'IQ';
let configurationRevision = 0;

function reset(): void { ring = new Float32Array(fftSize * 2); ringIndex = 0; received = 0; sinceFrame = 0; demodulator = new IqDemodulator(sampleRate, demodulation); }

self.onmessage = (event: MessageEvent) => {
  const data = event.data;
  try {
    if (data.type === 'init') {
      configurationRevision = data.configurationRevision;
      sampleRate = data.sampleRate; centerFrequency = data.centerFrequency; fftSize = data.fftSize; source = data.source;
      demodulation = data.demodulation; reset(); return;
    }
    if (data.type === 'config') {
      configurationRevision = data.configurationRevision;
      if (data.centerFrequency !== undefined) centerFrequency = data.centerFrequency;
      if (data.demodulation !== undefined) demodulation = data.demodulation;
      reset(); return;
    }
    if (data.type !== 'iq') return;
    const iq = new Float32Array(data.buffer);
    for (let k = 0; k < iq.length; k += 2) { ring[ringIndex * 2] = iq[k]!; ring[ringIndex * 2 + 1] = iq[k + 1]!; ringIndex = (ringIndex + 1) % fftSize; received++; sinceFrame++; }
    const audio = demodulator.process(iq);
    if (audio.samples.length) self.postMessage({ type: 'audio', samples: audio.samples, sampleRate: audio.sampleRate, timestamp: data.timestamp, source, configurationRevision }, { transfer: [audio.samples.buffer] });
    if (received >= fftSize && sinceFrame >= sampleRate / 20) {
      sinceFrame %= Math.ceil(sampleRate / 20);
      const ordered = new Float32Array(ring.length);
      ordered.set(ring.subarray(ringIndex * 2), 0); ordered.set(ring.subarray(0, ringIndex * 2), (fftSize - ringIndex) * 2);
      const frame = { ...analyzeIqSpectrum(ordered, sampleRate, centerFrequency), timestamp: data.timestamp, source };
      self.postMessage({ type: 'frame', frame, configurationRevision }, { transfer: [frame.bins.buffer] });
    }
  } catch (error) { self.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error), configurationRevision }); }
  finally { if (data.type === 'iq') self.postMessage({ type: 'ack' }); }
};
