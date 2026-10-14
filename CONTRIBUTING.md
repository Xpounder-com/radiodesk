# Contributing to RadioDesk

RadioDesk is an open source amateur radio workspace distributed as one HTML file. Keep the source modular, outputs inspectable and source/device states accurate. Application and original bridge code are MIT; vendored modem/runtime code retains its own notices.

## Develop and verify

Use Node 22.6+ and Python 3.10+:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:4173`. Before proposing a change:

```sh
npm run check
```

This checks strict TypeScript, behavioral/reference tests (including seven standard-library Python bridge tests), builds `dist/radiodesk.html` and verifies eight workspace routes, actual worker/WASM embedding, license notices and standalone assets. `npm run test:bridge` runs bridge checks separately. Node tests import explicit `.ts` paths and use type stripping; avoid constructor parameter properties or other syntax that needs runtime transformation. The browser target is ES2022.

Normal builds use the checked-in modem WASM. A modem C/source change requires `npm run build:ftx` with the pinned Emscripten SDK, an updated provenance manifest and matching binary/fixture tests. See [ftx.md](docs/ftx.md). Do not silently replace a compiled binary or discard dependency notices.

Open the generated HTML directly and through localhost. Exercise changed actions by keyboard/pointer and at a narrow viewport. Verify console behavior, source start/stop/switch, permission denial/cancellation, listening/mute, imports/downloads and offline operation. Record the browser/OS actually checked. Source/fixture results are not physical hardware or all-browser validation.

## Keep boundaries clear

Read [architecture.md](docs/architecture.md). Domain mathematics/protocols belong in pure validated functions with explicit units. Device, audio, IQ, modem and transmit services own resources/state. Views present state and explicit actions and clean up subscribers. Navigating away from an IQ view must not terminate an independently running receiver; active/queued transmit must follow the application's cancellation policy. Preserve unfinished inputs during unrelated state updates.

New modules need unique metadata, lifecycle ownership and deliberate app/workspace wiring. `ModuleRegistry` does not automatically load/start plugins. Embed required workers/WASM/maps/media, document licenses and memory costs, and preserve the single-file build. Avoid runtime CDNs or hidden remote dependencies.

Tests should cover behavior that can fail: malformed fragments, codec interoperability, timing/cancellation, resource release, bounds, numerical edges and regressions. Use independent protocol vectors/captured PCM or separately derived reference values. A formula duplicated into expected values is weak evidence. Keep ideal circuit/geometry limits and simulated sources explicit.

## Hardware and transmit contributions

Support begins with a named model and primary protocol documentation. An open port or matching USB id does not prove a radio model. Do not probe arbitrary devices or choose a port automatically. Tie permissions to deliberate operator actions and keep receive/control truth separate from desired settings.

Generic drivers, direct FT-891 control and optional Hamlib control/PTT are implemented but all physical integrations remain unverified. Add drivers through the typed contract and factory registry. Capability claims must come from supported backend operations; configured Hamlib identity is not independent physical identification. Keep both client and bridge tests, structured operation allowlists, bounded leases and release-on-session-loss behavior. Preserve raw receive allowlists, identity-bound transmit scopes, fresh state pins, bounded deadlines, priority RX, revocation, selected audio routes and explicit arm acknowledgements. Never restore an arm from storage, auto-key after reconnect, automatically reply/repeat, or turn a manual hold into a toggle. RX remains unconfirmed when release/readback fails. Independent hardware timeout/interlock requirements must remain clear.

The SDR bridge is an optional local hardware adapter. Preserve loopback binding/fixed upstream, exact Origin/token verification, receive opcode allowlisting, framing and bounded queues. An RTL0 header establishes protocol compatibility, not acceptance of a requested rate/frequency/gain. Track sample drops and configuration revisions so downstream slot decoders cannot treat discontinuous audio as a complete receive window.

Use [hardware.md](docs/hardware.md), [transmit.md](docs/transmit.md) and [sdr.md](docs/sdr.md) for bench checks. Record model/firmware, OS/browser, interface, audio input/output, baud/framing and actual settings. Test readbacks/manual dial changes, unplug/reconnect, timeouts, RTS/DTR opening/closing, PTT release paths, hidden/blur/pagehide, clock changes, missed slots and independent RF shutdown. Redact personal/device identifiers. Mock UART or simulated IQ tests must be described as such.

## Signal, modem and data integrity

Use [signals.md](docs/signals.md) and [ftx.md](docs/ftx.md) for PCM/modem contracts. Receiver audio is not wideband IQ; dBFS is not dBm or a calibrated S-meter; geometry is not an HF forecast; a synthetic vector is not an on-air reception. FT8/FT4 results must come from actual PCM and valid decoder checks. Costas score must not be labelled SNR and unresolved hashes must not become invented callsigns.

Preserve active-waveform versus padded-slot WAV semantics and explicit UTC offsets. Sample/clock/source gaps should reject a receive window. Reply composition, encoding, audio preparation, arming and a one-shot send are separate operator actions. Include independent receive recordings and provenance, not only encoder/decoder loopbacks. Keep vendored source pins, WASM/source hashes, licenses and test-fixture distribution scope inspectable.

Keep station data local unless the operator chooses export or a clearly presented integration. Application HTML export must omit live contacts, settings, device labels, endpoint tokens and dialogs. Importers validate structure/lengths/dates/modes/units before persistence, and views escape untrusted text. Preserve unknown fields instead of manufacturing frequencies, locations, reports or messages.

Storage/log changes must preserve existing data, serialize mutations and test failure/retry/interchange paths. Document migrations and recovery/export procedures. Do not introduce telemetry or store access tokens in station backups.

## Describe a change

Give a bug's reproduction, expected/observed behavior, browser/OS and a small redacted trace/file when useful. Contributions should state the user-visible result, relevant tradeoffs, primary sources, verification performed and remaining limits. Describe the highest layer actually tested, and keep source, tests, generated artifacts and documentation aligned.
