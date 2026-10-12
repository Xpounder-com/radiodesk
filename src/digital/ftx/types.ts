export type FtxMode = 'FT8' | 'FT4';
export interface FtxEncodeOptions { audioHz?: number; sampleRate?: 12000 | 24000 | 48000; volume?: number; freeText?: boolean }
export interface EncodedTransmission {
  message: string;
  mode: FtxMode;
  /** Active waveform only; schedule at slot UTC + startDelaySeconds. */
  samples: Float32Array;
  sampleRate: number;
  tones: Uint8Array;
  payload: Uint8Array;
  /** Full-slot WAV, including leading start delay and trailing silence. */
  wav: ArrayBuffer;
  slotSeconds: number;
  signalSeconds: number;
  startDelaySeconds: number;
}
export interface FtxDecodeResult {
  text: string;
  mode: FtxMode;
  audioHz: number;
  /** Estimated signal start relative to the supplied slot; not a calibrated WSJT-X DT. */
  timeOffsetSeconds: number;
  /** Costas synchronisation score. This is deliberately not reported as SNR. */
  syncScore: number;
}
export interface FtxModem {
  encode(message: string, mode: FtxMode, options?: FtxEncodeOptions): Promise<EncodedTransmission>;
  decode(samples: Float32Array, sampleRate: number, mode: FtxMode): Promise<FtxDecodeResult[]>;
  reset(): Promise<void>;
  dispose(): void;
}
export const FTX_PROTOCOL = {
  FT8: { slotSeconds: 15, symbolSeconds: 0.16, symbols: 79, toneSpacingHz: 6.25, startDelaySeconds: 0.5 },
  // One ramp symbol precedes the first Costas symbol at nominal +0.5 seconds.
  FT4: { slotSeconds: 7.5, symbolSeconds: 0.048, symbols: 105, toneSpacingHz: 1 / 0.048, startDelaySeconds: 0.452 },
} as const;
