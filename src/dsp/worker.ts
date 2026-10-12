/** A closure-free worker entrypoint. Function text survives bundling into one HTML. */
function dspWorkerMain(): void {
  const scope = globalThis as unknown as { onmessage: (event: { data: any }) => void; postMessage: (message: any, transfer?: ArrayBuffer[]) => void };
  let rate = 48000, size = 2048, gain = 1, ring = new Float32Array(size), write = 0, filled = 0, elapsed = 0;
  type Section = { b0: number; b1: number; b2: number; a1: number; a2: number; x1: number; x2: number; y1: number; y2: number };
  let filters: Section[] = [];
  function makeSection(highpass: boolean, frequency: number): Section {
    const omega = 2 * Math.PI * frequency / rate, cosine = Math.cos(omega), alpha = Math.sin(omega) / (2 * Math.SQRT1_2), a0 = 1 + alpha;
    const b0 = (highpass ? 1 + cosine : 1 - cosine) / 2;
    return { b0: b0 / a0, b1: (highpass ? -(1 + cosine) : 1 - cosine) / a0, b2: b0 / a0, a1: -2 * cosine / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
  }
  function configure(data: any): void {
    if (typeof data.gain === 'number') gain = data.gain;
    if (typeof data.lowHz === 'number' && typeof data.highHz === 'number') {
      filters = [makeSection(true, data.lowHz), makeSection(false, data.highHz)];
    }
  }
  function spectrum(timestamp: number): void {
    const real = new Float64Array(size), imag = new Float64Array(size);
    let sum = 0, energy = 0;
    for (let i = 0; i < size; i++) {
      const sample = ring[(write + i) % size], window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1));
      real[i] = sample * window; sum += window; energy += sample * sample;
    }
    for (let i = 1, j = 0; i < size; i++) {
      let bit = size >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
    }
    for (let length = 2; length <= size; length <<= 1) {
      const half = length >> 1, phase = -2 * Math.PI / length;
      for (let base = 0; base < size; base += length) {
        for (let j = 0; j < half; j++) {
          const a = base + j, b = a + half, c = Math.cos(phase * j), s = Math.sin(phase * j);
          const tr = real[b] * c - imag[b] * s, ti = real[b] * s + imag[b] * c;
          real[b] = real[a] - tr; imag[b] = imag[a] - ti; real[a] += tr; imag[a] += ti;
        }
      }
    }
    const bins = new Float32Array(size / 2);
    let peak = 1;
    for (let i = 0; i < bins.length; i++) {
      bins[i] = Math.max(-140, 20 * Math.log10(Math.max(1e-7, Math.hypot(real[i], imag[i]) * (i === 0 ? 1 : 2) / sum)));
      if (i > 0 && bins[i] > bins[peak]) peak = i;
    }
    let delta = 0;
    if (peak > 0 && peak < bins.length - 1) {
      const a = bins[peak - 1], b = bins[peak], c = bins[peak + 1], d = a - 2 * b + c;
      if (Math.abs(d) > 1e-8) delta = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d));
    }
    const sorted = Array.from(bins.subarray(1)).sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    const noiseDb = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    const rms = Math.sqrt(energy / size);
    scope.postMessage({ type: 'frame', frame: { bins, fftSize: size, sampleRate: rate, peakHz: rms > 1e-7 ? (peak + delta) * rate / size : 0, peakDb: bins[peak], noiseDb, rms, timestamp } }, [bins.buffer]);
  }
  scope.onmessage = event => {
    const data = event.data;
    if (data.type === 'init') {
      rate = data.sampleRate; size = data.fftSize || 2048; ring = new Float32Array(size); write = filled = elapsed = 0;
      configure(data);
    } else if (data.type === 'config') configure(data);
    else if (data.type === 'samples') {
      const samples = new Float32Array(data.buffer);
      for (let i = 0; i < samples.length; i++) {
        let value = Number.isFinite(samples[i]) ? samples[i] : 0;
        for (const c of filters) {
          const output = c.b0 * value + c.b1 * c.x1 + c.b2 * c.x2 - c.a1 * c.y1 - c.a2 * c.y2;
          c.x2 = c.x1; c.x1 = value; c.y2 = c.y1; c.y1 = output; value = output;
        }
        ring[write] = value * gain; write = (write + 1) % size; filled = Math.min(size, filled + 1); elapsed++;
      }
      if (filled === size && elapsed >= rate / 20) { elapsed %= rate / 20; spectrum(data.timestamp); }
      scope.postMessage({ type: 'ack' });
    }
  };
}

export const DSP_WORKER_SOURCE = `(${dspWorkerMain.toString()})();`;
