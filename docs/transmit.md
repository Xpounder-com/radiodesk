# Guarded FT-891 transmit

RadioDesk provides real FT-891 CAT PTT behind explicit operator arming and a bounded transmit coordinator. It starts disarmed, does not restore an arm from storage, and does not transmit when a receiver is connected or discovered. The simulator uses the same arming/hold/scheduling API and remains labeled as simulation.

This implementation is tested with protocol mocks and controlled timing tests. No physical FT-891 transmit, RF output, serial release, or digital audio timing was exercised in building it. Hardware behavior remains physically unverified. That verification limit is separate from feature availability: guarded PTT is callable after the operator completes its checks and explicitly arms it.

## Protocol and independent failsafe

The primary reference is [Yaesu FT-891 CAT Operation Reference Book, 1909-C](https://www.yaesu.com/Files/4CB893D7-1018-01AF-FA97E9E9AD48B50C/FT-891_CAT_OM_ENG_1909-C.pdf), page 18. `TX1;` starts CAT-controlled transmit, `TX0;` requests receive, and `TX;` reads state. `TX2;` is an answer for radio-local transmit; it is never used as a data-transmit command. DATA-USB and the rear-audio route are operator-selected radio settings. The app does not rewrite mode, BFO, source, VOX, or power menus when transmitting.

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

Arming obtains a fresh radio snapshot, requires confirmed receive, and pins the current frequency/mode. A wrong model, unavailable PTT driver, unverified hardware state, external transmit, mismatch, hidden page, or missing acknowledgement rejects arming. Blur, pagehide, and hidden-document events also cancel an arm while its snapshot is still pending. Visibility is checked again after the snapshot, so a missed event cannot arm a hidden page. A canceled snapshot cannot restore arming; returning to the page requires a new explicit arm. The FT-891 obtains another complete frequency/mode/TX readback before `TX1;`, so a physical dial change after arming does not silently transmit on a different frequency. Frequency/mode changes are blocked during pending/active PTT and revoke an idle arm when their new readback arrives.

`getState()` returns an immutable `TxState`: `armed`, `status`, `operatorCall`, `frequencyHz`, `mode`, `maximumSeconds`, `rxConfirmed`, `scheduledAtUtcMs`, `source`, `elapsedMs`, `simulated`, and optional `error`. Status progresses through disarmed, armed, pending, transmitting, releasing, or fault; scheduled sends also have a scheduled phase. `rxConfirmed: null` means receive has not been established, not that the radio is safely unkeyed. `subscribe()` returns an unsubscribe function.

## Manual hold and release

Call `holdPTT()` on a deliberate pointer/key-down action and `releasePTT()` on every corresponding up, pointer cancel, lost capture, and canceled keyboard interaction. Repeated key-down events must not create independent holds. A manual release keeps the checked arm available for a later deliberate hold; emergency/cancellation/disarm requires a new arm. The control must not behave as a PTT toggle.

The default maximum hold is ten seconds; an explicit operator setting can select 1–30 seconds. A monotonic deadline begins before the key request. A watchdog checks deadlines, page visibility, clock consistency, and radio TX readbacks. The coordinator cancels on window blur, pagehide, and hidden-document events while armed; the UI may also release on navigation or dialog changes. `emergencyStop(reason?)`, `disarm(reason?)`, and `dispose()` stop scheduled audio, revoke scopes, clear timers, and attempt RX when PTT may have been asserted.

Session scopes are opaque and bound to their identified connection. Receive-only raw transactions cannot write PTT. A scope is checked again at the actual serialized TX write; cancellation revokes queued TX requests. Priority RX invalidates all scopes and writes `TX0;` before waiting for queued status work. Only a subsequent `TX0;` answer establishes confirmed RX. A late TX acknowledgement cannot reassert state after its permit was revoked.

## One scheduled digital send

`scheduleOnce()` accepts exactly one explicit send. It does not repeat a slot, automatically reply, restart after reconnect, or catch up a missed slot. Real-radio digital sends require a verified DATA-USB readback. The audio owner must select and verify the actual transmit audio route; CAT permission does not establish an audio device.

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

`scheduleOnce()` resolves after queuing the one-shot plan, not after transmitting it. Follow state to observe completion/cancellation. Prepare audio before scheduling. `startAudio()` is called only after CAT TX readback and at the requested boundary; it should schedule playback promptly and return promptly. A rejected start invokes cleanup. If a deferred start finishes after cancellation, `stopAudio()` is called again so playback cannot resurrect. Stopping audio must be idempotent.

Missed key/audio boundaries are canceled rather than transmitted late. A UTC clock change greater than 200 ms relative to the monotonic clock cancels the plan. Timers are browser timers and are not a claim of measured FT8/FT4 on-air synchronization. Validate sample-rate conversion, output route, CAT latency, audio onset/end, RF envelope, and clock offset on physical equipment before claiming interoperable on-air transmission. Duration and lifecycle controls apply while a slot is queued or transmitting.

## Test and physical evidence

`tests/transmit.test.ts` covers explicit arm gates, wrong model, rejected/readback-failed PTT, raw-scope forgery, TX2 rejection, duration limits, blur/visibility/pagehide during pending arming and active transmit, missed visibility events, external TX, dial changes, release/disconnect races, one-shot ordering, late slots, UTC jumps, audio cancellation, and absence of automatic repeat. `tests/radio.test.ts` covers identity, framing, serializer, timeout, chooser, and port lock lifecycle. These tests use mocked UART streams and controlled clocks; they do not radiate RF.

Follow [hardware.md](hardware.md) for bench verification. Record radio model/firmware, OS/browser, interface, baud/framing, BFO/input/power/TOT settings, independent failsafe, and measured behavior. Include evidence for every release path and failure case. Do not infer verified RF shutdown from a successful promise or an application status label.
