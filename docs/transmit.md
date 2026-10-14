# Guarded radio transmit

RadioDesk provides radio-driver PTT behind explicit operator arming and a bounded transmit coordinator. The direct FT-891 driver and the local Hamlib bridge use the same capability-based API. A driver must advertise both PTT control and transmit-state readback; receive-only drivers remain unable to arm. It starts disarmed, does not restore an arm from storage, and does not transmit when a receiver is connected or discovered. The simulator uses the same arming/hold/scheduling API and remains labeled as simulation.

This implementation is tested with protocol mocks and controlled timing tests. No physical radio transmit, RF output, serial release, or digital audio timing was exercised in building it. Hardware behavior remains physically unverified. That verification limit is separate from feature availability: guarded PTT is callable after the operator completes its checks and explicitly arms it.

## Protocol and independent failsafe

The generic coordinator uses the connected driver’s state and capabilities instead of a radio-model allowlist. Each driver owns its protocol and current-state validation. The Hamlib bridge’s model name comes from the operator’s rigctld configuration, not independent physical-radio identification. A successful Hamlib readback establishes software connection/state verification, not a claim that the chosen model or RF behavior was bench-tested.

Hamlib transmit requires a successful split-VFO readback establishing simplex. Split transmit and backends without a usable split readback remain receive-only for PTT. The bridge checks split, frequency, mode and PTT again before the backend key command; enabling split or losing the readback revokes an existing transmit plan. It does not assume that an RX VFO frequency establishes the TX frequency on a split-enabled radio.

The bridge also reads the actual Hamlib runtime PTT route and frontend cache configuration. Physical transmit requires the radio backend route (`RIG` or `RIGMICDATA`); RTS, DTR, GPIO and other frontend keying routes are rejected. The Dummy backend can additionally use `None`, since it has no physical PTT path. Start rigctld with `-C cache_timeout=0` for transmit so frontend cached frequency/mode/PTT values cannot authorize a key request. The bridge checks these settings again before keying and never changes them automatically. After a split or safety-configuration failure, restore the intended settings and reconnect to obtain fresh capabilities before arming again.

For the direct FT-891 driver, the primary reference is [Yaesu FT-891 CAT Operation Reference Book, 1909-C](https://www.yaesu.com/Files/4CB893D7-1018-01AF-FA97E9E9AD48B50C/FT-891_CAT_OM_ENG_1909-C.pdf), page 18. `TX1;` starts CAT-controlled transmit, `TX0;` requests receive, and `TX;` reads state. `TX2;` is an answer for radio-local transmit; it is never used as a data-transmit command. DATA-USB and the rear-audio route are operator-selected radio settings. The app does not rewrite mode, BFO, source, VOX, or power menus when transmitting.

The menu table distinguishes CAT TOT (05-07, command timing) from TX TOT (05-14, transmit timeout, with 00 disabled and 01–30 minutes available). A command timeout is not an RF transmit failsafe. Before arming, independently configure and verify the radio-native transmit timeout or another independent transmit interlock, and keep a physical means to stop RF. A one-minute radio timeout is much longer than a normal browser hold; the native limit remains a fallback if the browser fails.

The browser cannot guarantee receive after a crash, suspended process, USB removal, OS failure, or blocked JavaScript event loop. Physical PTT, VOX, or another device can keep the radio transmitting or rekey it. UI status therefore reports **RX unconfirmed** when release/readback fails. A failed serial session gets a bounded best-effort `TX0;` attempt if it may have keyed the identified FT-891, then releases its port resources. Independent RF shutdown is still required.

## Operator arm

`src/transmit/controller.ts` exports `TransmitController` (also exported as `SafetyCoordinator`). Construct one around the application's `RadioController`; its state is volatile and is never persisted.

```ts
const transmit = new TransmitController(radio);
await transmit.arm({
  operatorCall: 'N0CALL',
  frequencyHz: radio.getState().frequency,
  mode: radio.getState().mode,
  maxTransmitSeconds: 10,
  acknowledgements: {
    authorizedOperator: true,
    frequencyAuthorized: true,
    antennaOrDummyLoad: true,
    independentFailsafe: true,
    audioRouteVerified: true,
    physicalUnverified: true,
  },
});
```

The booleans in this example show API fields, not UI defaults. Each represents an explicit operator confirmation. Collect every acknowledgment from the operator and pass the values only after a deliberate Arm action. Validate the responsible callsign, operating authorization, frequency/mode, antenna or dummy load, independent failsafe, and selected input/output route.

Arming obtains a fresh radio snapshot, requires confirmed receive, and pins the current frequency/mode. Unavailable PTT or transmit-readback capabilities, disconnected or unverified hardware state, unknown or external transmit, a mismatch, a hidden page, or a missing acknowledgement reject arming. Explicit simulator drivers use their simulated capability and remain silent; a Hamlib dummy model is also treated as simulation. Changing the driver, configured model, identity source, or simulation classification revokes the arm. Blur, pagehide, and hidden-document events also cancel an arm while its snapshot is still pending. Visibility is checked again after the snapshot, so a missed event cannot arm a hidden page. A canceled snapshot cannot restore arming; returning to the page requires a new explicit arm. Drivers obtain another current frequency/mode/TX readback before keying, so a physical dial change after arming does not silently transmit on a different frequency. Frequency/mode changes are blocked during pending/active PTT and revoke an idle arm when their new readback arrives.

`getState()` returns an immutable `TxState`: `armed`, `status`, `operatorCall`, `frequencyHz`, `mode`, `maximumSeconds`, `rxConfirmed`, `scheduledAtUtcMs`, `source`, `elapsedMs`, `simulated`, and optional `error`. Status progresses through disarmed, armed, pending, transmitting, releasing, or fault; scheduled sends also have a scheduled phase. `rxConfirmed: null` means receive has not been established, not that the radio is safely unkeyed. `subscribe()` returns an unsubscribe function.

## Manual hold and release

Call `holdPTT()` on a deliberate pointer/key-down action and `releasePTT()` on every corresponding up, pointer cancel, lost capture, and canceled keyboard interaction. Repeated key-down events must not create independent holds. A manual release keeps the checked arm available for a later deliberate hold; emergency/cancellation/disarm requires a new arm. The control must not behave as a PTT toggle.

The default maximum hold is ten seconds; an explicit operator setting can select a whole number of seconds from 1–30. A monotonic deadline begins before the key request. A watchdog checks deadlines, page visibility, clock consistency, and radio TX readbacks. The coordinator cancels on window blur, pagehide, and hidden-document events while armed; the UI may also release on navigation or dialog changes. `emergencyStop(reason?)`, `disarm(reason?)`, and `dispose()` stop scheduled audio, revoke scopes, clear timers, and attempt RX when PTT may have been asserted.

Transmit permits are opaque and bound to the active driver connection. The coordinator passes the selected maximum duration to `radio.acquireTransmitPermit(current, maximumSeconds, keyBeforeUtcMs?)` so an independent local bridge can enforce the same bounded lease. Scheduled sends also carry a latest key boundary 75 ms before the audio boundary; manual holds omit it. Receive-only raw transactions cannot write PTT. A scope is checked again at the actual serialized TX write; cancellation revokes queued TX requests. Priority RX invalidates all scopes. The direct FT-891 session writes `TX0;` before waiting for queued status work; the Hamlib bridge reads release requests independently of slow rigctld operations, cancels any pending pre-key command, closes its interrupted framing boundary, and performs priority receive release. Only a subsequent successful transmit-state readback establishes confirmed RX. A late TX acknowledgement cannot reassert state after its permit was revoked.

The Hamlib bridge starts its nonrenewable lease before attempting PTT. It also requires periodic client heartbeats and requests receive if the client stops responding or the WebSocket closes. These bridge timers are additional software safeguards, not substitutes for the independent radio-side failsafe. Hamlib generally reports a PTT value, not a separate external-transmit identity: the bridge labels nonzero readback during its own active lease as CAT transmit and nonzero readback outside that lease as external transmit. Physical PTT or VOX can still overlap a bridge-owned lease; that overlap cannot be distinguished by this inference.

## One scheduled digital send

`scheduleOnce()` accepts exactly one explicit send. It does not repeat a slot, automatically reply, restart after reconnect, or catch up a missed slot. Digital sends require a current armed mode included in the driver’s `digitalModes` capability. The direct FT-891 advertises DATA-USB only. The Hamlib bridge can advertise DATA-USB (mapped from Hamlib PKTUSB) and/or USB when supported by the configured model. USB capability does not configure the radio’s microphone/data input: the operator must verify the real route and radio settings before arming. The audio owner must select and verify the actual transmit audio route; CAT permission does not establish an audio device.

```ts
await transmit.scheduleOnce({
  id: 'operator-requested-slot',
  startAtUtcMs: nextAudioBoundaryUtcMs,
  durationMs: packetDurationMs,
  startAudio: () => preparedAudio.start(),
  stopAudio: () => preparedAudio.stop(),
  leadMs: 350,
  tailMs: 150,
});
```

`startAtUtcMs` is the **PCM/audio start boundary**. CAT keying begins `leadMs` earlier; defaults are 350 ms lead and 150 ms tail. The lead, complete audio duration, and tail must fit the armed maximum. For an approximately thirteen-second waveform, choose an explicit limit of at least fourteen seconds, or longer if measured hardware latency requires a larger lead. Lead can be 100–2000 ms and tail 0–1000 ms. The requested slot must leave at least 100 ms before keying and be within the next two minutes.

`scheduleOnce()` resolves after queuing the one-shot plan, not after transmitting it. Follow state to observe completion/cancellation. Prepare audio before scheduling. A separate pending-key deadline cancels and requests receive if CAT acknowledgement has not arrived by 75 ms before the audio boundary, even while the key promise remains pending. The Hamlib bridge also enforces the supplied boundary before its actual backend write. `startAudio()` is called only after CAT TX readback and at the requested boundary; it should schedule playback promptly and return promptly. A rejected start invokes cleanup. If a deferred start finishes after cancellation, `stopAudio()` is called again so playback cannot resurrect. Stopping audio must be idempotent.

Missed key/audio boundaries are canceled rather than transmitted late. A UTC clock change greater than 200 ms relative to the monotonic clock cancels the plan. Timers are browser timers and are not a claim of measured FT8/FT4 on-air synchronization. Validate sample-rate conversion, output route, CAT latency, audio onset/end, RF envelope, and clock offset on physical equipment before claiming interoperable on-air transmission. Duration and lifecycle controls apply while a slot is queued or transmitting.

## Test and physical evidence

`tests/transmit.test.ts` covers generic driver PTT/readback capability gates, unknown-state rejection, driver/model replacement, duration-permit forwarding, split-aware arming/revocation, late Hamlib acknowledgements after release, USB digital scheduling, silent dummy classification, explicit arm gates, wrong direct-driver model, rejected/readback-failed PTT, raw-scope forgery, TX2 rejection, duration limits, blur/visibility/pagehide during pending arming and active transmit, missed visibility events, external TX, dial changes, release/disconnect races, one-shot ordering, late slots, UTC jumps, audio cancellation, and absence of automatic repeat. `tests/radio.test.ts` covers identity, framing, serializer, timeout, chooser, and port lock lifecycle. These tests use mocked UART/WebSocket streams and controlled clocks; they do not radiate RF.

Follow [hardware.md](hardware.md) for bench verification. Record radio model/firmware, OS/browser, interface, baud/framing, BFO/input/power/TOT settings, independent failsafe, and measured behavior. Include evidence for every release path and failure case. Do not infer verified RF shutdown from a successful promise or an application status label.
