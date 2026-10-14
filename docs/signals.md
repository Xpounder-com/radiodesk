# Signal engine and digital audio

RadioDesk's receive spectrum uses actual PCM audio. A microphone is an audio interface, not an RF receiver: connect a suitable receiver's audio output or use an interface, subject to its input limits. The synthetic demo is explicitly identified and contains generated tones and noise. No station data is inferred from it.

## Audio API

`src/audio/engine.ts` exports `SignalEngine`, `SignalFrame` and `PcmFrame`:

- `subscribe(listener)` returns an unsubscribe function.
- `subscribePcm(listener)` supplies received mono `samples`, actual `sampleRate`, `endUtcMs`, labelled `source` and source `generation`. PCM is borrowed until the callback returns; copy before retaining. For AudioWorklet capture, UTC follows `currentFrame` sample positions mapped through an AudioContext/UTC anchor, rather than main-thread block arrival. Synthetic blocks use an arrival-time fallback. Physical receiver/driver/ADC latency is not calibrated. The application routes selected PCM to the FT8/FT4 slot collector and excludes active transmit audio.
- `startDemo()` starts a deterministic, silent synthetic audio source at 48 kHz.
- `await startMicrophone(deviceId?)` asks the browser for microphone permission. Echo cancellation, automatic gain and noise suppression are requested off. Browser/device implementations can still apply processing. Microphone audio is never routed to the speakers.
- `await importWav(arrayBuffer)` validates a WAV, downmixes to mono and plays it through the current audio passband and gain. The browser resamples to its AudioContext rate. File playback is audible.
- `stop()` ends source, tracks, worklet, worker and audio context. Captured recording chunks remain available through `stopRecording()`.
- `setGain(linearGain)` accepts 0–20. `setBandpass(lowHz, highHz)` configures a cascaded Butterworth highpass and lowpass; edges are clamped below the actual Nyquist rate.
- `startRecording()` and `stopRecording(): Blob | null` capture raw mono PCM before gain and filters, then export signed PCM16 WAV. Finish an existing recording before starting another. In-memory capture is capped at ten minutes and reports the limit in the console. Pending worklet samples introduce up to one 512-sample block of capture latency at stop.
- `source`, `sampleRate`, `droppedFrames` are read-only. Dropped frames count discarded input blocks when more than eight DSP messages are pending.

AudioWorklet and Worker sources are bundled strings loaded through Blob URLs. The distributed HTML requires no separate worker file. Microphone and AudioWorklet availability depend on the browser's secure-context and local-file policy; localhost/HTTPS is the reliable route when direct `file:` use does not permit capture. No audio is uploaded.

## Measurements

The default FFT is 2048 points, radix 2, with a Hann window and coherent-gain amplitude correction. A one-sided spectrum reports dBFS per bin, floored at −140 dBFS, rather than dBm. A full-scale coherent sine approaches 0 dBFS at its peak bin. At 48 kHz, bin spacing is 23.4375 Hz. Parabolic log-magnitude interpolation refines an isolated tone's peak-frequency estimate; it does not improve the physical FFT resolution.

`SignalFrame` includes `bins: Float32Array`, `sampleRate`, `fftSize`, `peakHz`, `peakDb`, `noiseDb`, `rms`, and `timestamp` (browser monotonic milliseconds). DSP runs in a worker and publishes about 20 frames per second. The noise estimate is the median of positive-frequency bin magnitudes, not an RF noise-power calibration or guaranteed signal-to-noise ratio. RMS is measured after the selected receive filters and gain. No S-units, RF power, antenna gain or receiver sensitivity are derived without a separately supplied hardware calibration.

`src/dsp/fft.ts` exports the reference `fft` and `analyzeSpectrum`; `filters.ts` exports normalized RBJ biquad coefficients and a stateful filter. The inline worker is tested against the reference FFT. The WAV reader walks RIFF chunks, validates bounds and padding, accepts PCM 8/16/24/32 and IEEE float32, and averages channels to mono. Compressed WAV, RF64 and arbitrary extensible subformats are rejected.

## Digital tools

`src/digital/morse.ts` supplies International Morse text encode/decode, standard PARIS timing, Farnsworth spacing, downloadable practice WAV, a key-duration decoder and an offline fixed-tone audio decoder. Key events use monotonic milliseconds and a supplied speed; automatic speed detection is not claimed. Unknown symbol groups become a replacement character. Audio decode is intended for clean single-tone recordings with the configured character and spacing speeds. It is not a general weak-signal CW receiver.

`src/digital/rtty.ts` supplies ITA2 letters/figures shifts, five-bit encode/decode, 1 start + 5 LSB-first data + 1.5 stop timing, phase-continuous FSK WAV generation and a fixed-tone Goertzel demodulator. Defaults are 45.45 baud, 2125 Hz mark and 170 Hz shift. Reverse swaps mark and space. The international ITA2 table excludes national/private figure assignments. It does not claim automatic baud, tuning, AFC or robust fading/multipath decoding. Exported practice signals and their decoded clean-audio reference cases are tested.

The user interface decodes WAV files up to 32 MB and two minutes locally in a disposable worker, so WAV parsing and demodulation do not block the interface. `decodeDigitalWav(mode, arrayBuffer, options)` transfers the input buffer to the worker, returns a result promise, and terminates the worker and revokes its Blob URL on completion, failure or the 90-second timeout. The build bundles this worker and embeds its script text through `__RADIO_DESK_DECODER_WORKER__`; the distributed HTML remains self-contained. Generated practice WAVs can run up to ten minutes. Pure codec and practice functions generate PCM/WAV and do not issue CAT commands.

Signal Lab's **Send audio once** controls wrap the generated CW/RTTY PCM in the application's guarded one-shot transmit coordinator. They require deliberate arming in Signal Lab’s own transmit panel, a selected/confirmed radio audio route and a confirmed driver-supported digital audio mode (DATA-USB for direct FT-891; supported DATA-USB or USB through Hamlib). Audio duration plus CAT lead/tail must fit the armed maximum, so a long practice file is rejected rather than sent partially. CW audio does not operate the hardware CW keyer; RTTY audio does not operate its FSK input. Local practice/export/decoding remain separate actions and never key a radio. Workspace navigation stops output and disarms; an asynchronous audio preparation cannot survive navigation and key later. Simulator sends are silent. See [transmit.md](transmit.md).

## Modem extension boundary

FT8 and FT4 are implemented in a persistent local worker with an embedded C/WASM modem: real message packing, CRC/LDPC, waveform synthesis and PCM receive decoding. The separate FT8 / FT4 workspace collects complete UTC windows from selected receiver PCM or SDR demodulation, imports recorded receive audio, exports slot WAVs and allows one explicitly scheduled prepared send. Independent FT8 and official FT4 recordings validate receive compatibility separately from encoder/decoder loopbacks. See [ftx.md](ftx.md) for its actual API, supported message families, timing and limits.

Wideband IQ is separate from the mono engine. `SdrController` accepts actual rtl_tcp IQ or bounded stereo/raw IQ imports, publishes an absolute RF FFT and demodulates a selected channel locally. `subscribeAudio` provides demodulated PCM even with speakers muted, along with cumulative sample drops and configuration revision. SDR receive-window UTC is arrival based; receiver/ADC, transport and processing latency are not calibrated. Changing the drop count or configuration revision invalidates a digital receive window. There is no direct browser USB SDR driver claim; the optional native bridge is documented in [sdr.md](sdr.md).

Additional WSPR, PSK31, SSTV and packet implementations need actual PCM input, compatible licenses and independent references. No synthetic decode is displayed as an on-air message. An extension should declare mode/capabilities/rates/settings/source license and test vectors, and can implement a PCM-input/result-output contract:

```ts
interface DigitalDecoder {
  id: string;
  modes: string[];
  sampleRates: number[];
  configure(settings: Record<string, number | string | boolean>): void;
  process(samples: Float32Array, sampleRate: number, timestamp: number): void;
  onMessage(listener: (message: {
    text: string; mode: string; timestamp: number;
    audioHz?: number; confidence?: number;
  }) => void): () => void;
  reset(): void;
}
```

As the existing FT8/FT4 modem does, embed additional WASM binaries in the generated HTML, document license/memory/thread requirements and validate published vectors plus independently captured audio before describing support. No modem registry is downloaded at runtime. Callsign placeholders, unresolved hashes and unsupported message families must remain explicit rather than becoming invented results.

## Primary references

- [W3C Web Audio API](https://www.w3.org/TR/webaudio-1.0/), AudioWorklet and BiquadFilter definitions.
- [McGill MMSP WAVE file specifications](https://www-mmsp.ece.mcgill.ca/Documents/AudioFormats/WAVE/WAVE.html), RIFF chunks, PCM and extensible formats.
- [ITU-R M.1677-1: International Morse code](https://www.itu.int/rec/R-REC-M.1677-1-200910-I), alphabet and signal timing.
- [ITU-T S.1: International Telegraph Alphabet No. 2](https://www.itu.int/rec/T-REC-S.1/en), codeword assignments, shifts and serial element order.
