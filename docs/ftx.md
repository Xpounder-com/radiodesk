# Real FT8 and FT4 modem

RadioDesk embeds a real C FT8/FT4 modem as WebAssembly. Message packing, the 14-bit CRC, LDPC(174,91), Costas synchronisation, Gray tone mapping, Gaussian continuous-phase modulation and receive decoding execute locally. Decode results come from input PCM and pass the upstream LDPC/CRC checks. The modem makes no network requests and has no CAT/PTT commands.

## Upstream and build

The implementation is [Kārlis Goba's ft8_lib](https://github.com/kgoba/ft8_lib), pinned to commit `9fec6ca39886edbf96f4f5e71edc76da5074e871`. Its source license is MIT. Its included KISS FFT routines are BSD-3-Clause; both licenses are retained in `vendor/ft8_lib`. Emscripten, musl libc and statically linked math notices are retained in `wasm/LICENSE-*` and included with the HTML distribution. Upstream source directories are unmodified. The RadioDesk bridge, `wasm/ftx-bridge.c`, adapts the upstream Gaussian waveform synthesis and supplies bounded message and PCM interfaces.

The checked-in binary is `wasm/ftx.wasm`. Normal application builds embed it; a browser does not download a WASM file or compiler at runtime. The worker is independently bundled with `__RADIODESK_FTX_WASM__` set to the binary's base64 text. The main bundle receives the worker script in `__RADIODESK_FTX_WORKER__`.

To rebuild the binary, install the official [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html), select **6.0.12**, and run:

```sh
EMCC=/path/to/emsdk/upstream/emscripten/emcc node build/build-ftx.mjs
```

`wasm/ftx-build.json` records the compiler version, upstream commit, source hashes and binary SHA-256. Tests validate these hashes so a source edit requires rebuilding the binary. The module initially allocates 16 MiB and is bounded at 64 MiB. No native toolchain is required for ordinary `npm ci`, tests or HTML builds.

## API

`src/digital/ftx/modem.ts` exports `createFtxModem()` and the types. The async factory creates a persistent local worker and instantiates WASM.

```ts
const modem = await createFtxModem();
const transmission = await modem.encode('CQ K1ABC FN42', 'FT8', {
  audioHz: 1000, sampleRate: 12000, volume: 0.2,
});
const decoded = await modem.decode(receivedMonoPcm, audioSampleRate, 'FT8');
await modem.reset(); // Reset the bounded hashed-callsign cache.
modem.dispose();
```

Encoding accepts the upstream supported CQ, standard exchanges, signal reports, RRR/RR73/73 and nonstandard-call message families. Explicit `freeText: true` packs the actual 71-bit free-text format, limited to thirteen characters from `A–Z`, `0–9`, space and `+ - . / ?`. The application compares the unpacked result with the requested message and rejects any silently altered message. Contest families absent from the upstream library are not advertised as supported.

`EncodedTransmission` returns `message`, `mode`, `samples`, `sampleRate`, `tones`, `payload`, `wav`, `slotSeconds`, `signalSeconds`, and `startDelaySeconds`. **`samples` contains only the active waveform.** Schedule that buffer at `UTC slot start + startDelaySeconds`. **`wav` contains a full slot**, including leading and trailing silence, for interoperable saved-file decoding. Starting the full-slot WAV at the active-waveform offset would add the delay twice.

| Mode | Slot | Symbols | Symbol period | Active PCM | Active waveform starts |
| --- | --- | --- | --- | --- | --- |
| FT8 | 15 s | 79 | 0.160 s | 12.64 s | slot + 0.500 s |
| FT4 | 7.5 s | 105 | 0.048 s | 5.04 s | slot + 0.452 s |

FT4 includes one ramp symbol before its first Costas symbol at nominal slot +0.500 s. Audio synthesis uses BT=2 for FT8 and BT=1 for FT4, with tapered edges. Encode rates are 12, 24 or 48 kHz; the browser can resample playback to the output-device rate. The complete tone set is bounded to 200–3000 Hz; gain is an audio amplitude, not RF power.

Decoding accepts mono 6–192 kHz PCM, resamples with a bandlimited polyphase filter to 12 kHz, and searches the 200–3000 Hz audio band. Each job can cover at most two minutes; longer inputs are split into contiguous mode-length slots. The input's first sample must correspond to the desired slot boundary for meaningful timing and consecutive-slot segmentation. Recordings shorter than one slot can decode if they contain almost all active symbols. A persistent worker keeps a bounded 256-entry callsign hash cache between slots. Unresolved hashes remain the upstream placeholder rather than invented callsigns.

Results are `{text, mode, audioHz, timeOffsetSeconds, syncScore}`. Timing is an estimated signal start relative to the supplied audio, after compensating the monitor's one-symbol delay. Its resolution is half a symbol (80 ms FT8, 24 ms FT4). It is not a calibrated WSJT-X DT measurement. `syncScore` is the upstream Costas score, **not SNR**. There is no claim of WSJT-X's sensitivity, a priori / deep decoding, multi-pass signal subtraction, complete contest formats or a calibrated received-power scale.

Worker operations time out after 90 seconds and dispose the failed modem. `dispose()` terminates the worker and rejects pending jobs. `decode()` copies and transfers receive PCM so callers retain their original buffer. Encode transfers its new result arrays back to the UI.

Live audio capture uses AudioWorklet `currentFrame` sample positions, mapped to UTC with a context-clock anchor. This avoids treating delayed main-thread delivery as dropped PCM. Missing input quanta discard a partly filled worklet block and increment a discontinuity counter. A sample-sequence gap, UTC clock step or suspended context invalidates the current receive window. Receiver source generation/discontinuity and SDR configuration/drop identities prevent combining different captures. This clock mapping does not calibrate physical receiver, driver or ADC latency.

The UTC collector requires a fully present slot, with only one sample of numerical placement tolerance. Startup partial slots are skipped even when they exceed95percent coverage. If a decoder remains occupied when the next complete live window arrives, that window is counted as skipped instead of building an unbounded queue. Mode/source changes suppress stale live decode results; preparation has a separate generation so receive startup does not erase a valid same-mode packet. A canceled or superseded preparation never overwrites a newer packet.

## Validation

Binary tests cover actual message packing, published Costas sequences, both symbol counts and waveform durations, free text and standard exchanges, slot padding, message-alteration rejection, frequency/timing recovery, resampling and silence producing no decoded messages.

Two independent recorded PCM fixtures validate actual receive decoding separately from RadioDesk's transmitter:

- `191111_110145.wav` from the pinned upstream corpus, with reference text `GJ0KYZ RK9AX MO05` at about 1234 Hz.
- The official [WSJT-X FT4 sample](https://sourceforge.net/projects/wsjt/files/samples/FT4/000000_000002.wav/download), SHA-256 `d9e91fa04ba138a7b9f41b4103823c77ca1c3a9775101f6b14d60935bcd3813b`. The modem resolves CRC-verified messages including `WD9IGY KX1X 73` and `CQ RU W1QA FN32`. This fixture is test data and is excluded from the distributed HTML.

Fixture provenance and licenses are recorded in `vendor/ft8_lib/UPSTREAM.md`. These checks establish protocol execution and receive compatibility with those recordings; they do not establish a hardware-specific sensitivity threshold or prove physical RF transmission.

## Protocol references

- [WSJT-X User Guide](https://wsjt.sourceforge.io/wsjtx-main_en.html), FT8/FT4 protocol definitions and operating timing.
- [Official FT4 protocol description](https://wsjt.sourceforge.io/FT4_Protocol.pdf), synchronization and weak-signal decoding.
- [ft8_lib](https://github.com/kgoba/ft8_lib), inspected encoder, message packer, LDPC/CRC decoder, monitor and GFSK synthesis source.
