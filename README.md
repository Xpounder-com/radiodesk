# RadioDesk

**An open source amateur radio workspace. One self-contained HTML file.**

**[Open the live app](https://xpounder-com.github.io/radiodesk/) · [Download standalone HTML](https://github.com/Xpounder-com/radiodesk/releases/latest/download/radiodesk.html)**

RadioDesk combines station control, wideband SDR reception, receiver audio analysis, a real FT8/FT4 modem, RF engineering tools, a local logbook and an offline world path map. Source modules stay readable TypeScript and C; the distribution embeds the application, styles, workers, modem WebAssembly, map data and dependency notices.

There is no account, cloud backend, analytics or runtime CDN. Simulated, imported and live sources are labelled. Physical device access requires an operator action. Transmit starts disarmed and never arms itself after reconnect or reload.

## Use it

Use the [live HTTPS app](https://xpounder-com.github.io/radiodesk/), or [download `radiodesk.html`](https://github.com/Xpounder-com/radiodesk/releases/latest/download/radiodesk.html) and open the saved file in a modern browser. Both contain the complete application. RF calculations, the map, logging, synthetic signal practice, IQ/WAV imports and FT8/FT4 encoding/decoding run locally. Browser storage and hardware permissions vary for `file:` origins; export logs and JSON backups for portability. The built artifact is also available at [`dist/radiodesk.html`](dist/radiodesk.html).

For microphone capture and Web Serial, use localhost or HTTPS in a supporting browser:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:4173**. This launcher rebuilds the same HTML on page load. It is for local preview; offline tools do not depend on a running server.

For radios supported by Hamlib, use the [local bridge helper](https://github.com/Xpounder-com/radiodesk/releases/latest/download/hamlib_ws.py), install the verified Hamlib 4.7.2 separately, select the exact model with `rigctld -l`, and start its daemon bound to loopback:

```sh
rigctld -m YOUR_MODEL_ID -r YOUR_CAT_DEVICE -P RIG -C cache_timeout=0 -T 127.0.0.1 -t 4532
python3 bridge/hamlib_ws.py
```

Choose **Connect radio → Hamlib · local radio bridge** and paste the token-bearing endpoint printed by the bridge. It discovers the configured backend, modes and controls; unsupported controls remain disabled. Hamlib model selection is not automatic physical-radio identification. The bridge defaults to receive control; transmit additionally requires `--allow-transmit`, supported PTT readback and a separate operator arm. See [Hamlib setup and compatibility](docs/hamlib.md) for serial settings, dummy-radio testing, exact origins, browser restrictions and release behavior. The application remains one HTML file; Hamlib and the optional Python helper run locally beside it.

For actual RTL-SDR hardware, start the optional native receiver adapter:

```sh
rtl_tcp -a 127.0.0.1 -p 1234 -s 2048000
python3 bridge/rtl_tcp_ws.py
```

Paste the complete token-bearing WebSocket endpoint printed by the bridge into **SDR**. When opening the HTML directly from disk, start the bridge with `--allow-file-origin`. See [SDR setup](docs/sdr.md) for origins, controls, sample-rate bounds and source limits. The client and DSP remain inside the HTML; native `rtl_tcp` and the bridge provide the hardware connection.

For the hosted app, explicitly allow its origin when starting your local bridge: `python3 bridge/rtl_tcp_ws.py --origin https://xpounder-com.github.io`. The bridge stays bound to local loopback; the public website cannot access a radio without your device connection and permissions.

## Eight workspaces

| Workspace | Implemented functionality |
| --- | --- |
| Station | VFO, direct FT-891 identity and configured Hamlib model/capability discovery, frequency/mode/PTT readbacks, step tuning, memories, labelled simulator, quick logging, explicitly armed bounded hold-to-transmit and emergency RX |
| Signal Lab | Mono audio FFT and waterfall, live receiver/microphone audio, filters, WAV playback/recording, CW and ITA2/RTTY encoding, practice waveforms, controlled WAV decoding and separately armed one-shot audio sends |
| SDR | Real rtl_tcp IQ protocol over WebSocket, fragmented-header/sample handling, requested tune/rate/gain controls, full complex RF FFT/waterfall, local AM/FM/USB/LSB listening, stereo IQ WAV/raw imports and visible sample-drop counters |
| FT8 / FT4 | Embedded C/WASM message packing, CRC/LDPC encoding and receive decoding, UTC-slot capture from receiver audio or SDR, independent recorded-file compatibility, editable reply composition, slot WAV export and one explicitly scheduled send |
| Engineering | Antenna dimensions, Smith chart, complex reflection/VSWR, return/mismatch loss, loss-aware line transforms, L matching, Butterworth low/high/bandpass ladders and responses, cable loss and unit/resonance tools |
| Logbook | Local contacts, search, UTC/reports/grids, ADIF import/export, duplicate prevention, recoverable deletion, JSON backup and merging |
| Propagation | Embedded Natural Earth land map, Maidenhead conversion, short/long great-circle paths and bearings, UTC solar position, night shading, terminator and twilight boundaries |
| Devices | Permission-aware audio/serial inventory, explicit device selection, FT-891 identity checks, Hamlib capability discovery, connection settings, lifecycle/status and selected radio audio output |

## Transmit and hardware status

Guarded **FT-891 CAT PTT and capability-gated Hamlib PTT are implemented**. An operator must explicitly arm the current frequency/mode, select and verify the radio audio route, confirm an antenna or dummy load and an independent radio transmit failsafe, and choose a bounded duration. The app pins the armed state, obtains fresh readbacks before keying, and revokes scopes when a send is canceled. Manual PTT is a hold action. Digital scheduling sends one prepared waveform once; it does not automatically reply or repeat a slot. Changing workspaces stops transmit output and disarms. Hidden-page/blur events, missed timing and clock changes also cancel applicable sends. Failed release/readback reports **RX unconfirmed**.

The browser cannot guarantee RF shutdown after a crash, suspended process, unplugged interface or operating-system failure. The physical radio timeout/interlock and an independent stop remain necessary. The simulator exercises the control path without RF output. Details and bench procedures are in [transmit.md](docs/transmit.md) and [hardware.md](docs/hardware.md).

Signal Lab also sends generated CW/RTTY audio once after deliberate arming in Signal Lab’s transmit panel, through the selected radio output in a confirmed, driver-supported audio mode (DATA-USB for the direct FT-891; available DATA-USB or USB through Hamlib). These are audio modulation, not hardware CW-keyer or FSK-keying support. Long audio is rejected if it cannot fit the armed maximum.

**All physical hardware integrations, including FT-891, RTL-SDR and Hamlib models, remain physically unverified in this project.** Protocol fixtures, worker execution, timing tests and recorded PCM establish the tested software paths; they do not establish measured radio tuning, RF release, USB/sound-card behavior, modem sensitivity or on-air transmit timing.

## Measurement and modem limits

- Receiver audio is an audio passband. Complex SDR IQ exposes a separate RF span. Both spectra use dBFS per FFT bin, without antenna/dBm/S-meter calibration. rtl_tcp controls are labelled requested because its protocol offers no setting acknowledgements or RF readback.
- FT8/FT4 results come from input PCM and pass upstream LDPC/CRC checks. Costas sync score is not SNR. Supported messages, timing, source provenance and independent FT8/FT4 receive fixtures are documented in [ftx.md](docs/ftx.md). Complete WSJT-X sensitivity, every contest family and deep/multipass decoding are not claimed.
- UTC slot capture requires contiguous samples. AudioWorklet receiver PCM uses `currentFrame` sample positions mapped to UTC through a context-clock anchor; SDR demodulated audio uses arrival-based UTC. A source change, sample drop or SDR configuration revision invalidates a receive window. Physical receiver/driver/ADC latency and audio/CAT timing remain uncalibrated.
- CW/RTTY WAV decoders use matching fixed settings and clean single-signal inputs. Antenna lengths are trimming estimates, filter responses assume ideal components, and daylight geometry is not an HF forecast.
- WAV import is bounded to 100 MB; mono recording to ten minutes; IQ import to 64 MiB. FT8/FT4 UI imports accept up to two slots and 32 MiB. Download recordings and backups before changing environments.
- ADI uses ASCII fields; RadioDesk metadata and JSON retain international text. BAND-only contacts keep an unknown exact frequency. Band labels are not transmit authorization. Full ADX interchange is not implemented.
- Station data persists locally through IndexedDB, localStorage or temporary memory. The HTML file does not carry that browser storage. **Download HTML** exports application code and omits live station/contact DOM; ADIF/JSON exports carry user data separately.

## Build and verify

Contributors need Node **22.6+** and Python **3.10+**. Development and CI use Node 24; Python tests use only the standard library. There are no runtime npm dependencies. The checked-in FT8/FT4 WASM means normal HTML builds do not need a C compiler.

```sh
npm ci
npm run check
```

`check` runs strict TypeScript and behavioral/reference tests (including both Python bridge suites), builds the HTML and verifies its actual contents. The artifact gate checks eight navigation/render cases, all three independently compiled worker scripts, exact modem WASM bytes/hash, complete license notices, inline-only runtime assets and an empty application root before user data loads.

Tests include RF reference circuits, numerical geometry, audio/IQ FFTs and compiled-worker execution, WAV/IQ parsing, CW/RTTY codecs, FT8/FT4 protocol vectors and independently recorded receive PCM, serial identity/framing/readbacks/timeouts, guarded PTT and cancel/deadline races, bridge origin/token/frame boundaries, and concurrent contact persistence. These are distinct from browser and physical-device validation; exercise the generated artifact, permissions, source changes, listening, downloads and bounded send behavior before a hardware release.

Browser checks exercised the eight-workspace build, independent FT8 and official FT4 recorded PCM imports, a silent one-shot FT4 simulator send ending in confirmed RX/disarmed state, and a synthetic IQ peak at centre +20 kHz with no local sample drops during that check. Desktop and narrow viewport checks found no horizontal overflow. These results do not establish physical radio or sound-interface behavior.

CI builds the official, checksum-pinned Hamlib 4.7.2 release and runs its actual in-memory Dummy backend. Older OS packages may lack the required runtime safety queries and leave controls disabled. To run that integration locally, set `RADIODESK_HAMLIB_TEST_BINARY` to your installed `rigctld` executable before `npm run check`; it always selects Dummy model 1 and never opens a radio port. Without that variable, only this optional native integration is skipped.

Useful separate commands are `npm run test:bridge`, `npm run verify` after a build, and `npm run build:ftx` to rebuild the modem with the documented Emscripten toolchain. See [architecture](docs/architecture.md) and [FTX build provenance](docs/ftx.md).

## Contribute and license

Read [CONTRIBUTING.md](CONTRIBUTING.md), [architecture](docs/architecture.md), [SDR](docs/sdr.md), [Hamlib](docs/hamlib.md), [FT8/FT4](docs/ftx.md), [transmit](docs/transmit.md), [signals](docs/signals.md) and [engineering](docs/engineering.md). Preserve the single-file build, source labels, explicit control paths and inspectable test evidence. Additional named radios/modems, rotators, calibrated instruments, propagation models and electromagnetic solvers can extend these boundaries.

RadioDesk application and original bridge code use [MIT](LICENSE). The embedded `ft8_lib` is MIT, KISS FFT is BSD-3-Clause, and Emscripten/musl/math notices are retained in source and in the HTML. Natural Earth data is public domain. Optional native Osmocom `rtl-sdr` and Hamlib retain their own licenses and are not copied into the client or original MIT bridge. Hamlib is installed separately; no Hamlib source or binary is embedded in the HTML. The independent WSJT-X test recording has separate upstream provenance and a retained GPL notice; it is excluded from the HTML. See [FTX provenance](docs/ftx.md), [fixture provenance](vendor/ft8_lib/UPSTREAM.md) and [map provenance](docs/source-data.md).
