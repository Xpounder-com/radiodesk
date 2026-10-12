/** Capture is silent: microphone audio is never routed back to speakers. */
export const CAPTURE_WORKLET_SOURCE = `
class RadioDeskCapture extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(512); this.offset = 0; this.previousInputEnd = null; this.discontinuities = 0; }
  process(inputs, outputs) {
    const channels = inputs[0];
    const count = channels && channels[0] ? channels[0].length : 0;
    if (count && this.previousInputEnd !== null && currentFrame !== this.previousInputEnd) {
      this.block = new Float32Array(512); this.offset = 0; this.discontinuities++;
    }
    for (let i = 0; i < count; i++) {
      let sample = 0;
      for (let c = 0; c < channels.length; c++) sample += channels[c][i];
      this.block[this.offset++] = sample / channels.length;
      if (this.offset === this.block.length) {
        this.port.postMessage({ buffer: this.block.buffer, endFrame: currentFrame + i + 1, discontinuities: this.discontinuities }, [this.block.buffer]);
        this.block = new Float32Array(512); this.offset = 0;
      }
    }
    if (count) this.previousInputEnd = currentFrame + count;
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor('radiodesk-capture', RadioDeskCapture);
`;
