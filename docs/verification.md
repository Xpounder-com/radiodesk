# RadioDesk 0.3.0 verification

Verified locally on 2026-10-13. Direct reference targets are the Yaesu FT-891 and RTL-SDR; additional station control uses Hamlib. No physical radio was opened or keyed and no RF transmission or physical transmit audio was produced. Hamlib 4.7.2 was built from its official release and exercised only with its in-memory Dummy model.

## Automated checks

`npm run check` passed strict TypeScript, **203 Node tests with no skips**, the single HTML build, and the artifact gate. The bridge runners executed seven RTL-SDR and forty Hamlib Python tests, plus one actual native Hamlib Dummy integration. CI installs Hamlib and enables the native integration with `RADIODESK_HAMLIB_TEST_BINARY`; local runs without that variable skip only the optional native test.

The artifact gate compares all three embedded workers with their actual compiled sources, verifies exact FT8/FT4 WASM bytes and provenance hash, requires eight implemented workspaces, and checks complete dependency notices inside the document head. The release contains one inline script and stylesheet, no external runtime assets and an empty application root.

Behavioral checks include independent recorded FT8/FT4 receive fixtures, 48 kHz PCM through the live UTC collector and real FT4 decoder, complex IQ processing through the compiled SDR worker, loopback bridge transport, incomplete-slot/drop rejection, delayed audio cleanup, stale preparation/rearm cancellation, CAT scope/readback limits and emergency release paths. See the corresponding `tests/ftx*.test.ts`, `tests/sample-clock.test.ts`, `tests/slots.test.ts`, `tests/sdr*.test.ts`, `tests/radio.test.ts`, `tests/transmit.test.ts`, `tests/output.test.ts`, and `tests/receive-output.test.ts`.

## Browser checks

The earlier modem/SDR flows below were exercised in the Codex in-app Chromium browser. The 0.3.0 Hamlib flows were exercised in Chrome’s neuralint profile at `http://127.0.0.1:4173/`, with the actual Hamlib 4.7.2 Dummy daemon and local bridge:

| Flow | Observed result |
| --- | --- |
| Hamlib connection | Configured Dummy model identified and labeled simulated; no automatic arm |
| Generic tuning and modes | 145.001 MHz and WFM read back from the actual daemon; USB and 14.074 MHz also confirmed |
| Transmit opt-in | Runtime CAT route, zero daemon cache, simplex and PTT readback accepted; default receive bridge reported transmit unavailable |
| Final Hamlib FT4 send | Explicit simulator arm, one scheduled send entered CAT TX readback and finished disarmed; daemon returned PTT 0 afterward; no physical audio |
| Hamlib setup layout | Desktop 1506 × 882 and narrow 390 × 844 viewport; no document horizontal overflow and setup dialog fit within the narrow viewport |
| Invalid endpoint | Non-loopback unencrypted connection rejected locally; error omitted the access token |
| Export while connected | Downloaded HTML parsed, kept one inline script/style and empty app root, included the Hamlib client and omitted the connection token |
| FT8 encode and prepared-WAV decode | `CQ K1ABC FN42`, 79 symbols, 12.64 seconds of active PCM; the loopback result was explicitly labeled |
| Independent FT8 receive recording | `GJ0KYZ RK9AX MO05` decoded from the unchanged upstream recording |
| Official independent FT4 recording | Seven verified messages, including `WD9IGY KX1X 73` and `CQ RU W1QA FN32` |
| FT8 and FT4 scheduled send | Each silent simulator send ran once and returned to disarmed RX |
| Navigation cancellation | A queued FT8 send was canceled when switching workspaces; the destination showed disarmed controls |
| CW audio send | One short generated CW waveform completed through the silent simulator and returned to disarmed RX |
| SDR synthetic IQ | Explicit fixture produced a peak at centre +20 kHz, with RF spectrum/waterfall and no observed dropped samples |
| Manual digital log dialog | FT8 was selected; signal reports were empty and required operator entry rather than invented SNR |
| Download HTML | Downloaded file retained modem dependency notices, one script/style and an empty app root; decoded callsign/source rows were omitted |
| Responsive layout | Desktop at 1440 px and phone layout at 390 px; no document-level horizontal overflow; the narrow navigation scrolls within its own container |
| Console | No captured warnings or errors during these browser flows |

## Remaining verification boundary

Browser and protocol tests do not establish actual FT-891 USB/CAT opening behavior, RF tuning or release, RTL-SDR gain/rate acceptance, sound-card routing, measured modem sensitivity, or on-air audio timing. The native RTL-SDR connection needs `rtl_tcp` and its optional local bridge. Hamlib coverage depends on model capabilities and operator configuration; native Dummy verification does not certify any physical model. Its transmit opt-in changes the shared daemon’s cache to zero during discovery and verifies runtime route/readbacks; backend hardware behavior and measured RF release still require bench evidence. See [Hamlib setup](hamlib.md). Device-level procedures are in [hardware.md](hardware.md), [transmit.md](transmit.md), and [sdr.md](sdr.md). Direct `file:` browser permissions vary; the browser exercises above used localhost.
