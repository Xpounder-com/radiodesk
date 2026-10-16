# Hamlib radio bridge

RadioDesk can control the operator's own radio through a separately installed Hamlib `rigctld` and the optional Python standard-library bridge in `bridge/hamlib_ws.py`. The browser app remains one self-contained HTML file. Hamlib, its radio drivers, and the Python bridge run locally and are not embedded in that file. CAT control does not carry audio; select the radio's audio interface separately in RadioDesk.

The bridge starts with transmit disabled. A configured model and successful readback establish a usable daemon connection, not independent physical-radio identification. No physical radio or RF output has been verified for this integration.

## Start the local services

Use **Hamlib 4.7.2** for the verified integration, available from its [official releases](https://github.com/Hamlib/Hamlib/releases/tag/4.7.2). Ubuntu’s 4.5.5 package failed the required runtime capability gate in CI. Older daemons that cannot supply these checks remain read only, with tuning/PTT disabled rather than implying confirmed receive. Newer versions must retain the documented protocol and runtime checks. Install Hamlib for your operating system, then use `rigctld --list` to find the model supported by your installed version. Configure the correct CAT device, baud rate, framing, radio menus, and PTT route using Hamlib's instructions and your radio's manual. Replace `MODEL_ID`, `RADIO_CAT_DEVICE`, and `CAT_BAUD` below with those values:

```sh
rigctld -m MODEL_ID -r RADIO_CAT_DEVICE -s CAT_BAUD -P RIG -C cache_timeout=0 -T 127.0.0.1 -t 4532
python3 bridge/hamlib_ws.py
```

To exercise the connection without radio hardware, start Hamlib's Dummy backend instead:

```sh
rigctld -m 1 -P RIG -C cache_timeout=0 -T 127.0.0.1 -t 4532
python3 bridge/hamlib_ws.py
```

RadioDesk labels this backend simulated. Its state can verify the daemon/bridge/browser path without establishing physical radio or RF evidence. Do not assign a PTT device to Dummy or select an RTS, DTR, GPIO or other external keying route; the bridge rejects those routes even for model 1. Stop the existing daemon before switching between Dummy and a real configured model.

Keep the daemon in its default current-VFO mode; do not start it with `-o` / `--vfo`. This bridge sends commands without an extra VFO argument. A backend that cannot follow the physical radio's selected VFO can report stale VFO state; compare the frequency and mode with the radio after changing its physical controls. [Hamlib daemon options and commands](https://hamlib.sourceforge.net/snapshots/man1/rigctld.1.html).

The bridge connects only to `127.0.0.1:4532` and listens only on `127.0.0.1:8766` by default. It prints an endpoint such as `ws://127.0.0.1:8766/radio?token=…`. Copy the complete endpoint into RadioDesk's Hamlib connection field, connect deliberately, and compare the reported model, frequency, mode, and PTT state with the radio. Discovery does not start these services or choose a serial device.

The bridge needs Python 3.10 or newer and no third-party Python packages. Its command-line options are:

| Option | Behavior |
| --- | --- |
| `--port 8766` | Local WebSocket listen port. |
| `--upstream-port 4532` | Local `rigctld` port; the upstream host stays `127.0.0.1`. |
| `--origin ORIGIN` | Exact permitted browser origin; repeat to allow several. Specifying any origin replaces the defaults. |
| `--allow-file-origin` | Adds opaque `Origin: null` for a downloaded HTML file. The token remains required. |
| `--token TOKEN` | Optional persistent token of 16–256 letters, digits, underscores or hyphens. By default the bridge prints a fresh random token. |
| `--allow-transmit` | Authorizes one daemon cache-disable operation and enables eligible guarded PTT; the browser still starts disarmed. |

The default origins are `http://127.0.0.1:4173` and `http://localhost:4173`. For the hosted app, permit its origin without the repository path:

```sh
python3 bridge/hamlib_ws.py --origin https://mehrdadxzaker.github.io
```

To permit the hosted app and the local development server together:

```sh
python3 bridge/hamlib_ws.py --origin https://mehrdadxzaker.github.io --origin http://127.0.0.1:4173 --origin http://localhost:4173
```

For a downloaded file, add `--allow-file-origin`. Browser mixed-content and local-network policies differ; if a hosted page cannot reach the loopback bridge, serve the HTML locally or use an operator-managed authenticated WSS adapter. The included bridge provides plain loopback WebSocket service, not TLS.

## Access boundary and capabilities

Every WebSocket upgrade requires the endpoint token, an explicitly allowed exact Origin, and a matching loopback Host header. A browser cannot supply a different upstream host, inject raw Hamlib commands, or select another device. Only one browser client owns the bridge connection at a time. Treat the printed token as local access authority; exclude it from screenshots, public logs, saved station profiles, and exported HTML.

Keep `rigctld` bound to loopback as shown above. Hamlib's daemon is a separate service whose security boundary is independent of this token-guarded bridge. [Hamlib's security guidance](https://hamlib.sourceforge.net/html/rigctld.1.html).

On connection, the bridge reads Hamlib's capabilities, supported modes, and current state. The model number, manufacturer, and model name come from `dump_caps`, so `identitySource` is `hamlib-configured`. The hello `model` is the numeric backend identifier as a string, such as `"1"`; `name` and `configuredModelName` provide configured labels. These describe the backend selected when the daemon was started. They do not prove which physical transceiver is attached. The Dummy backend is labeled simulated; it cannot establish evidence about a real radio.

Capabilities gate frequency and mode setters independently. A transceiver without usable PTT readback is read only. A backend positively described as a receiver with no advertised TX ranges or PTT setter can expose `hardwareReceiveOnly`; its receive state comes from that backend capability, rather than an invented PTT reply. PTT availability also requires the bridge's transmit opt-in, usable PTT readback, an advertised CAT PTT route, and a successful split-VFO readback confirming simplex. A serial RTS/DTR or GPIO output is not a physical radio readback. The explicitly labeled Dummy model is the simulation exception. Missing, unsupported, failed or malformed transceiver PTT readback is unknown state. Frequency ranges describe advertised backend coverage; they are not a license, jurisdictional band plan, or RF validation.

The bridge additionally reads the actual runtime PTT route using the fixed, nonmutating `get_conf ptt_type` query. Physical transmit requires `RIG` or `RIGMICDATA`; safe Dummy simulation permits `None` as well. External routes and unsupported queries disable PTT. On a transceiver they also make PTT unknown and disable frequency/mode setters, because an RTS/DTR frontend value does not establish radio receive state. The bridge verifies this route on each snapshot and before keying. Configuration probes use separate fixed-loopback connections, accommodating daemon versions that close a `get_conf` connection after its complete response.

The fixed `get_conf cache_timeout` query must return zero for PTT, because Hamlib's frontend otherwise can return cached frequency, mode and PTT state. `-C cache_timeout=0` is useful initial configuration, but Hamlib 4.7.2's polling startup can overwrite it. Starting this bridge with `--allow-transmit` explicitly authorizes a single internal `set_cache 0` command during initial discovery, followed by verification that the actual daemon cache is zero. This changes the shared daemon's cache policy for other clients; it changes no radio frequency, mode, menu or PTT state. The default receive-only bridge sends no setter at discovery. Unsupported cache preparation disables PTT. The bridge never resets caching during a keying attempt: if another client reenables it, keying is rejected until reconnect and discovery. Configuration checks precede transmit readbacks and run again for each keying attempt. No browser RPC exposes a configuration setter. These checks do not certify a backend's independent hardware behavior. [Hamlib runtime configuration](https://github.com/Hamlib/Hamlib/blob/master/src/conf.c), [PTT readback cache](https://github.com/Hamlib/Hamlib/blob/master/src/rig.c), [polling setup](https://github.com/Hamlib/Hamlib/blob/master/src/event.c).

RadioDesk uses canonical mode names at its browser boundary. The bridge maps only modes actually advertised by the daemon, with common mappings such as:

| RadioDesk mode | Hamlib token |
| --- | --- |
| `USB`, `LSB`, `CW`, `AM`, `FM` | Same token. |
| `CW-R` | `CWR` |
| `DATA-USB` | `PKTUSB` |
| `DATA-LSB` | `PKTLSB` |
| `RTTY` | `RTTY` |
| `RTTY-R` | `RTTYR` |
| `FM-N` | `FMN` |
| `AM-N` | `AMN` |

Other explicitly mapped modes include `WFM`, `AMS`, `DATA-FM`, `ECSS-USB`, `ECSS-LSB`, `SAM`, `SAL`, `SAH`, `DSB`, and `FA`. `RTTY-R` preserves Hamlib's reverse-mode meaning; this adapter does not infer a fixed BFO sideband from the RTTY token. The advertised `modes` list is authoritative; unsupported selections are rejected. `digitalModes` contains supported upper-sideband audio modes such as `DATA-USB` and, when advertised, `USB`. A mode token does not confirm the radio's audio-source menus, data connector, filter, VOX setting, or physical audio route. [Hamlib mode definitions](https://hamlib.sourceforge.net/manuals/4.7/group__rig.html).

## Browser bridge protocol

Protocol `radiodesk-hamlib-v1` uses WebSocket text messages containing one JSON object, bounded to 4096 bytes. Every request has a positive safe integer `id` and an allowed `op`; duplicate keys and unexpected fields are rejected. Success is `{ "id": 1, "ok": true, "result": … }`; failure is `{ "id": 1, "ok": false, "error": "…" }`. No operation accepts raw CAT or Hamlib text.

| Operation | Additional request fields | Result |
| --- | --- | --- |
| `hello` | None. | Protocol, name, model, `identitySource`, capabilities, and fresh snapshot. |
| `read` | None. | Fresh snapshot. |
| `frequency` | `value`: integer Hz. | Fresh snapshot after command/readback. |
| `mode` | `value`: supported canonical mode string. | Fresh snapshot after command/readback. |
| `ptt` | `active: true`, `expected: {frequency, mode}`, `maximumSeconds`: integer from 1–30; optional `keyBeforeUtcMs`: positive safe integer UTC deadline. | Direct string `"cat-tx"` after confirmed transmit readback. |
| `release` | None. | Direct string `"rx"` after confirmed receive readback; otherwise an error. |
| `heartbeat` | None. | `{ "alive": true }`. |

A snapshot contains `frequency` in integer Hz, canonical `mode`, `ptt`, `split` (boolean or null when unknown), and `txStatus`: `rx`, `cat-tx`, `external-tx`, or `unknown`. `rx` means the daemon returned receive state, or the explicitly flagged receive-only backend cannot transmit. `cat-tx` records transmit owned by the current bridge session; `external-tx` records transmit observed without that ownership. This software classification cannot distinguish every physical PTT, VOX, or keying source.

The hello capabilities include `frequency`, `mode`, `ptt`, `pttReadback`, `receiveOnly`, `hardwareReceiveOnly`, `splitReadback`, and `simulated` booleans; `modes` and `digitalModes` arrays; and `minFrequency` / `maxFrequency` in Hz. Runtime evidence includes `pttRoute` (or null), `pttRouteVerified`, `cacheTimeoutMs` (or null) and `freshReadback`. The last flag means the Hamlib frontend cache was disabled; it does not certify physical hardware. `receiveOnly` describes the bridge's permission policy; it is not physical receive-only proof. Detailed `frequencyRanges` retain disjoint advertised intervals rather than treating gaps as continuous coverage.

Example receive requests:

```json
{"id":1,"op":"hello"}
{"id":2,"op":"read"}
{"id":3,"op":"frequency","value":14074000}
{"id":4,"op":"mode","value":"DATA-USB"}
```

## Guarded transmit

Start the bridge with `--allow-transmit` only after configuring the intended radio and independent transmit failsafe. Then explicitly arm the current station in RadioDesk. Connecting, restoring a profile, and reading capabilities never arm the browser. The operator must confirm the selected radio, operating frequency and mode, legal operating privileges, audio route, and physical means of stopping RF.

Each PTT request includes the expected frequency/mode and a maximum duration of 1–30 whole seconds. The bridge checks fresh receive state, expected settings, and simplex before keying. RadioDesk sends heartbeats once per second while TX is active; absence for two seconds triggers a best-effort receive request. A heartbeat never extends the original deadline, and an active transmit lease cannot be renewed by sending another PTT request. Thirty seconds is the absolute software transmit ceiling. Watchdog expiry revokes the session, attempts to release its owned PTT, and closes the WebSocket. The operator must reconnect and arm again before any later transmit request.

The WebSocket reader handles release, disconnect and heartbeats independently of backend commands. Release revokes pending operations immediately and interrupts an in-flight read; the keying operation checks its generation again immediately before writing PTT. Backend commands remain serialized, and pending requests are bounded to sixteen. A release response requires a confirmed receive readback.

Scheduled digital sends can include `keyBeforeUtcMs`, the last permitted UTC millisecond for starting PTT. The bridge rejects expired deadlines or budgets more than thirty seconds ahead, captures a monotonic budget before backend queries, and checks both that budget and current UTC immediately before the keying write. Slow reads cannot extend the deadline; a backward clock change cannot extend its monotonic budget. Manual holds omit this field. UTC scheduling depends on the browser host and bridge host clocks; the bridge does not synchronize either clock.

Release, client loss, upstream failure, and duration expiry request RX for PTT owned by this session. Observed external PTT is reported for the operator to release at the radio; the bridge does not claim ownership of that transmitter state. A successful setter acknowledgement alone is insufficient to report confirmed RX; release needs uncached PTT readback. If the runtime route changes after keying, the bridge refuses to drive that different output and reports release unconfirmed. If caching is reenabled, it attempts RX through the original route and reports confirmation unavailable. Check PTT locally in either case. Keep other clients from changing daemon configuration during a RadioDesk session.

Frequency and mode setters are rejected while transmission is observed or transceiver PTT is unknown. Active or unreadable split disables PTT because the receive VFO does not establish the transmit frequency or mode. No power, VOX, tuner, split setter, memory, raw-command, radio-reset, or hardware-keyer operation is exposed. RIT, XIT, VOX, transverter offsets and radio-local audio settings are not changed or independently calibrated; verify them at the radio before arming. CW and RTTY playback use audio modulation through the selected audio route, and FT8/FT4 remain deliberate one-shot operations coordinated by RadioDesk. Hamlib CAT does not transport that audio.

These controls depend on the browser, bridge process, daemon, OS, connection, and radio continuing to operate. They are not an independent RF interlock. Use a suitable dummy load, conservative radio settings, and an independently verified way to stop transmission when performing first bench tests. A bridge crash, unplug, host failure, or blocked readback can prevent software release. See [transmit.md](transmit.md) for the operator arming and one-shot audio contract.

## Hamlib wire evidence

The upstream connection uses newline-delimited Hamlib Extended Response Protocol commands prefixed with `+`. Responses contain an echoed long command, labeled values when returned, and a terminating `RPRT` status. `RPRT 0` means backend success; a nonzero status is a failure. The bridge reads the complete bounded response before sending the next command. [Hamlib Extended Response Protocol](https://hamlib.sourceforge.net/snapshots/man1/rigctld.1.html).

These illustrative fixtures use one literal backslash on the TCP wire and a final newline after every line:

```text
Request: +\get_freq
Response:
get_freq:
Frequency: 14074000
RPRT 0

Request: +\get_mode
Response:
get_mode:
Mode: PKTUSB
Passband: 2400
RPRT 0

Request: +\get_ptt
Response:
get_ptt:
PTT: 0
RPRT 0

Request: +\set_freq 14074000
Response:
set_freq: 14074000
RPRT 0

Request: +\set_mode PKTUSB 0
Response:
set_mode: PKTUSB 0
RPRT 0

Request: +\set_ptt 0
Response:
set_ptt: 0
RPRT 0
```

Mode discovery uses `+\set_mode ?`, which returns an unlabelled, space-separated mode list. It does not change mode. `get_mode` reads current mode and is not the supported-mode query. `dump_caps` includes a top-level mode list, configured identity fields, Y/N capability fields, and nested per-range lists. Formatting varies by version; range section headings and field roles matter, and a per-range `Mode list` must not replace the global list. Primary implementations: [command parser](https://github.com/Hamlib/Hamlib/blob/master/tests/rigctl_parse.c) and [capability formatter](https://github.com/Hamlib/Hamlib/blob/master/tests/dumpcaps.c), inspected October 13, 2026.

## Physical verification record

Protocol fixtures and mock daemons test parsing, capability gates, authorization, heartbeat loss, maximum duration, and release failure. They do not certify hardware. For a contributed physical verification, record the radio model/firmware, Hamlib version/backend, CAT and PTT configuration, audio interface, browser/OS, and independent failsafe. Verify physical dial/mode changes, rejected tuning, external PTT, unsupported readback, unplug/reconnect, tab visibility loss, bridge termination, and every release path. Confirm actual RX and RF cessation with independent equipment; preserve unknown state when confirmation fails.
