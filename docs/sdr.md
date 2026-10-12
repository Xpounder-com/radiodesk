# Wideband IQ reception

RadioDesk now includes an implemented **rtl_tcp IQ receive client**, offline IQ playback, complex RF FFT/waterfall and local AM/FM/USB/LSB demodulation. The receiver client, worker DSP, UI and import decoders are embedded in the single HTML distribution. There are no client CDN scripts or runtime packages.

A browser WebSocket is not a raw TCP socket. Real RTL-SDR reception uses an operator-started native `rtl_tcp` receiver and the included small loopback WebSocket bridge. This does not claim universal SDR support or a direct RTL2832U USB driver. The bridge is an optional hardware adapter; ordinary RF engineering, logs and offline IQ files remain usable without it.

## Connect an RTL-SDR receiver

Install Osmocom's native `rtl-sdr` tools for your operating system and connect a compatible RTL2832 receiver. Run:

```sh
rtl_tcp -a 127.0.0.1 -p 1234 -s 2048000
python3 bridge/rtl_tcp_ws.py
```

For a RadioDesk HTML opened directly from disk, use:

```sh
python3 bridge/rtl_tcp_ws.py --allow-file-origin
```

Copy the **complete** `ws://127.0.0.1:8765/iq?token=…` endpoint printed by the bridge into SDR's endpoint field. Choose requested centre frequency, sample rate and gain, then connect. The client waits for a valid receiver header before reporting reception.

The bridge requires Python 3.10+ and uses its standard library. It does not install or invoke a driver, launch shell commands, select USB devices or key a transmitter. Upstream is fixed to `127.0.0.1`, normally port 1234. `--upstream-port` changes only that local port. The listener is fixed to `127.0.0.1`, normally port 8765. Both port arguments are bounded to 1–65535.

Default allowed page origins are exactly `http://127.0.0.1:4173` and `http://localhost:4173`. For another local page port, pass its exact origin with `--origin`, repeating if needed. Local-file `Origin: null` requires the explicit flag and still requires the random endpoint token. A supplied persistent `--token` must have at least 16 ASCII characters. Restarting the bridge generates a fresh token unless one is supplied.

The bridge handles one IQ client, validates HTTP Host/Origin/token before opening the upstream socket, rejects unsupported control opcodes, bounds control messages, requires masked client frames, handles fragmented binary messages/ping/pong/close, and bounds downstream writes with drain timeouts. Framing follows [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html). An HTTPS-hosted page may require an authenticated native `wss://` endpoint because its browser can block mixed-content `ws://` connections; the supplied local bridge itself provides plain loopback WebSocket, not TLS.

## Protocol and controls

The wire protocol was checked directly against [Osmocom's `rtl_tcp.c`](https://github.com/osmocom/rtl-sdr/blob/master/src/rtl_tcp.c). The initial 12 bytes contain ASCII `RTL0`, a big-endian uint32 tuner type and a big-endian uint32 gain-step count. Following data is interleaved unsigned-eight-bit I,Q. The parser accepts arbitrary header/data fragmentation and retains a trailing I byte across chunks. Normalisation is `(byte−127.5)/128`.

Commands are exactly five bytes: one opcode followed by a network-endian 32-bit value. Implemented controls are frequency `0x01` in Hz, sample rate `0x02`, gain mode `0x03` (0 automatic, 1 manual) and gain `0x04` in tenths of dB. The pure protocol helper and bridge also support signed PPM correction `0x05`. Bias-T, EEPROM, oscillator and direct-sampling changes are not exposed by this bridge.

**rtl_tcp does not acknowledge these commands or return the current tuned RF frequency/sample rate/gain.** RadioDesk therefore labels them requested, without hardware readback. The RF axis uses the requested centre/sample rate. A received tuner header proves a compatible byte stream, not acceptance of every requested setting. Gain count is not a list of supported gain values; choose settings supported by the actual tuner.

The [native RTL-SDR API](https://github.com/osmocom/rtl-sdr/blob/master/include/rtl-sdr.h) defines supported hardware rates as 225,001–300,000 or 900,001–3,200,000 Hz; the client and bridge enforce those ranges. The recommended initial rate is 2.048 MHz. Hardware tuning ranges and gain steps remain receiver dependent. HF reception may require a receiver's native direct-sampling configuration or an appropriate upconverter; the browser does not silently enable it.

## DSP and receive audio

`analyzeIqSpectrum` produces a full complex, fftshift spectrum covering `centre−Fs/2` through `centre+Fs/2` (upper edge exclusive). Negative and positive RF offsets remain distinct. Hann-window coherent gain normalises complex amplitude without the real-FFT factor of two. A window-weighted I/Q mean removes the centre DC spur. Magnitudes are **dBFS per FFT bin**, not calibrated dBm, field strength or S units.

The worker retains a bounded ring and emits up to 20 spectra per second. Main-thread dispatch is capped at four IQ blocks; oversized transport messages are rejected and data is converted in 64 KiB pieces. Skipped samples/blocks and speaker queue drops are visible. Frequency changes discard a 100 ms settling interval. This limits local memory/latency; it cannot detect or recover samples already dropped inside native RTL-SDR/rtl_tcp.

Each source/channel configuration has a revision. Stale worker audio/spectra from a previous revision are ignored. After an observed drop, processing state resets before the next accepted block. Digital consumers receive both cumulative dropped-sample count and configuration revision and should reject a slot that crosses either change.

`IqDemodulator` uses a recurrent complex oscillator to move the selected channel to baseband, an anti-alias complex Butterworth channel filter and integer decimation. AM/FM use sixth-order filtering. USB/LSB use eighth-order filtering around the selected positive/negative sideband (150 Hz through the chosen audio upper edge), then restore audio pitch. State is retained across block boundaries.

AM uses envelope magnitude with detector DC removed afterwards, preserving centre-frequency AM carriers. FM uses the angle of `z[n] conjugate(z[n−1])`, scaled by output rate and selected deviation; this is the same quadrature discriminator principle documented in [GNU Radio's API](https://www.gnuradio.org/doc/doxygen/classgr_1_1analog_1_1quadrature__demod__cf.html). This detector does not implement broadcast FM stereo, RDS or de-emphasis. Audio uses a sixth-order output low pass and is available to subscribers even with speakers muted. Speaker playback resamples the filtered audio continuously to the actual browser output rate, begins only from the listening action and has a bounded scheduling horizon.

These are working receive algorithms with reference fixtures. They are not a replacement for calibrated laboratory equipment, nor proof that an unavailable physical receiver has been verified.

## Offline IQ files

Supported imports are stereo RIFF WAV (I left, Q right; PCM 8/16/24/32 or float32), raw unsigned8 I,Q, raw signed16 little-endian I,Q and raw float32 little-endian I,Q. Stereo WAV channels are preserved as complex data, never averaged to mono. Mono receiver-audio WAV is rejected as IQ.

Raw imports require the original sample rate. All imports require operator-supplied RF centre metadata; file playback cannot retune hardware. Offline rates from 8 kHz to 3.2 MHz are accepted, subject to a valid selected channel. Files are bounded to 64 MiB and decoded into a normalised interleaved float array. Playback uses contiguous blocks at recording rate, once or looping. Use software channel offset within the recorded span; ordinary stereo music is not RF IQ.

The synthetic action is explicitly labelled as a fixture. It generates a known AM carrier at centre +20 kHz with 1 kHz audio and deterministic noise. It never implies a live station or receiver.

## Public API

`src/sdr/index.ts` exports `SdrController`, protocol helpers, IQ decoding, complex FFT analysis and streaming demodulation.

```ts
const sdr = new SdrController();
const stopFrames = sdr.subscribe(frame => {
  // bins, sampleRate, centre metadata, FFT size, timestamp, peak RF Hz,
  // dBFS/bin, RMS, source and absolute RF edges.
});
const stopAudio = sdr.subscribeAudio(frame => {
  // samples, sampleRate, timestamp, source, requested channel frequencyHz,
  // cumulative droppedSamples and configurationRevision. Reject digital
  // slots if either changes during capture.
});
await sdr.connect(endpoint, { centerFrequency: 100e6, sampleRate: 2048000 });
sdr.tune(100.2e6);
sdr.setGain(null); // automatic; number requests manual dB
sdr.setDemodulation({ mode: 'USB', offsetHz: 12000, bandwidthHz: 3000 });
await sdr.setListening(true, 0.5);
await sdr.setListening(false); // reception and audio subscribers continue
sdr.importIq(buffer, { kind: 'f32le', sampleRate: 192000,
  centerFrequency: 14.074e6, loop: false });
sdr.disconnect();
stopFrames(); stopAudio();
```

The exact frame field is `centerFrequency`, in Hz. `stats` returns a snapshot of source/state, header, requested controls, bytes/samples, drop counts, pending blocks, listening/demodulation and last error. UI cleanup removes view listeners; it does not disconnect the receiver on navigation.

## Verification and scope

`tests/sdr*.test.ts` checks all RTL header splits, arbitrary odd U8 fragments, packed signed/unsigned command references, ±RF tone frequencies/amplitudes, weighted DC removal, IQ channel preservation, malformed imports, AM/FM reference audio recovery, sideband selection/rejection and streaming continuity. Controller mocks check hardware command bytes, the four-block queue/drop counter and muted audio subscription. Seven Python tests check exact origin/host/token boundaries, receive opcode allowlisting, masked/fragmented frames and a simulated end-to-end bridge, including lock release after an upstream reset.

No RTL-SDR hardware was available for these checks. Test signals and simulated transports are explicitly labelled. Physical RF tuning, actual receiver gain/rate acceptance, USB permissions and sustained hardware reception remain device-level verification. No third-party SDR code has been copied into the MIT client/bridge; Osmocom's optional native software retains its own GPL license. No direct WebUSB RTL2832U/R820T driver is claimed.
