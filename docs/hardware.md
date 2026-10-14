# Hardware and browser support

RadioDesk's FT-891 driver implements CAT reception, frequency/mode control, and explicitly armed CAT PTT. It has not been verified on a physical FT-891. Automated tests exercise the protocol and transmit coordinator against mock UART streams; this is not a hardware certification. Connection starts with transmit disarmed. Tuner activation, hardware CW keying, power changes, and arbitrary CAT commands remain unavailable. Read [transmit.md](transmit.md) before using the guarded transmit feature.

## Connect an FT-891

1. Serve RadioDesk on `localhost` or HTTPS and use a browser with Web Serial support. The simulator works without Web Serial.
2. Connect the radio's USB CAT interface and install the manufacturer's virtual COM driver if your operating system needs it.
3. Select the **Enhanced** CAT COM port, not the Standard keying/PTT port. The browser may not display these names. Identify the port using your operating system before selecting it.
4. Match RadioDesk's baud rate to the radio's CAT RATE setting (menu 05-06). Disable CAT RTS (05-08), because this driver uses no hardware flow control and keeps RTS/DTR low. The current transport uses 8 data bits, no parity, and 2 stop bits.
5. Close other CAT software before connecting. Click Connect and select exactly that port in the browser chooser.
6. Compare the displayed frequency and mode with the radio. Tune within the receive range and confirm readback. Changing the physical dial should appear after the next poll.
7. Disconnect and confirm the OS port can be opened by another application. Unplugging, UART read errors, rejected commands, or timeouts clear the connected/verified state.

RadioDesk does not scan or open other serial ports. USB vendor/product IDs describe the interface, not the transceiver model. The driver checks radio identity before changing frequency or mode. Browser permission is tied to the origin and is not embedded in the exported HTML.

The Web Serial API applies explicit inactive signal settings after opening the OS port. It does not let this application guarantee signal levels during that opening interval. Selecting the correct CAT interface is essential; receive-only CAT software is not a physical transmit interlock.

## Protocol evidence

The primary protocol reference is [Yaesu FT-891 CAT Operation Reference Book, 1909-C](https://www.yaesu.com/Files/4CB893D7-1018-01AF-FA97E9E9AD48B50C/FT-891_CAT_OM_ENG_1909-C.pdf), retrieved October 11, 2026. The source files link each behavior to this reference.

| Reference pages | Implemented behavior |
| --- | --- |
| 2 | ASCII commands end with a semicolon. |
| 7 | CAT RATE supports 4800, 9600, 19200, and 38400 baud; CAT RTS is configurable. |
| 9 | `FA;` reads VFO A; frequency uses nine Hz digits, from 30 kHz to 56 MHz. |
| 10 | `ID;` returns model identifier `0650` for an FT-891. |
| 8, 11 | `MD0;` reads mode; SSB, RTTY, and DATA sideband depend on their BFO menus. Read-only `EX` queries resolve the displayed sideband. |
| 18 | `TX;` reads transmit status; guarded `TX1;` starts CAT TX and `TX0;` requests RX. `TX2;` is an external/radio-local TX answer and is never sent. |

A command allowlist permits identity/state queries and receiver frequency/mode setters. CAT PTT setters require an opaque, current operator transmit scope; arbitrary raw commands and `TX2;` writes are rejected. SSB mode changes are rejected if the radio's fixed BFO menu conflicts with the request. RadioDesk does not rewrite BFO menus. `verified` means an identified FT-891 returned a fresh CAT snapshot; it does not mean the radio, antenna, or RF output has been physically tested. `txStatus` distinguishes confirmed RX, CAT TX, external TX, and unknown state. A disconnect is not proof of receive.

## Audio, SDR, and other radios

Audio capture is separate from CAT. FT-891 USB CAT does not establish an audio stream in RadioDesk; select a browser-visible sound interface explicitly. Audio device names may be hidden until the operator grants microphone permission. Discovery itself never starts capture or asks permission.

RTL-SDR wideband IQ reception is implemented through native `rtl_tcp` and the included optional loopback WebSocket adapter, with requested frequency/rate/gain controls, complex RF FFT and AM/FM/USB/LSB demodulation. The 12-byte RTL0 header and unsigned-eight-bit IQ stream are parsed locally. The bridge is token/exact-Origin guarded and permits receive-control commands only. Follow [sdr.md](sdr.md) for setup. This target is protocol/fixture tested and has not been verified on physical RTL-SDR hardware. rtl_tcp has no setting acknowledgements, so its RF axis and controls remain requested metadata.

WebHID, WebUSB and Bluetooth capability detection reports browser APIs, not driver implementations. A direct WebUSB RTL2832U/R820T driver is not implemented; the native RTL-SDR adapter is the supported connection path. Direct Kenwood/Icom profiles are absent; supported models can instead use the optional [local Hamlib bridge](hamlib.md), with capabilities discovered from the selected backend. Additional drivers need a named model, primary protocol reference, protocol fixtures and separate physical verification before being described as hardware verified.

FT8/FT4 active waveforms and Signal Lab's CW/RTTY audio can be sent once through the selected radio audio route after deliberate arming in the current workspace’s transmit panel. Physical FT-891 audio sends require confirmed DATA-USB; CW is audio modulation, not the hardware CW keyer, and RTTY is AFSK audio, not the hardware FSK input. The browser does not rewrite mode/BFO/audio/VOX/power menus for the operator. Encoders themselves do not assert PTT. Simulator sends exercise state/timing with no physical audio or RF.

## Receive-only physical verification checklist

- Verify the chosen OS port and driver profile before connection; do not test arbitrary serial devices.
- Confirm baud/framing and that RTS/DTR remain inactive throughout connect, tune, disconnect, and unplug.
- Compare identity, frequency, mode, BFO override, and external PTT status against the radio display.
- Verify updates after physical dial/mode changes and after a commanded tune that the radio refuses.
- Verify timeout, incorrect port, malformed replies, unplug/replug, and reconnect behavior.
- Confirm that closing RadioDesk releases both serial locks and stops polling.
- Record radio firmware, browser/OS version, adapter, settings, and results in a contribution. Until that evidence exists, hardware support remains protocol-tested and physically unverified.

## Guarded transmit verification

Connection, discovery, a restored station profile, and the simulator never arm real transmit automatically. The operator must identify the radio, check frequency/mode and audio routing, configure an independent transmit limit/failsafe, acknowledge the physically unverified integration, and explicitly arm. Browser duration/visibility controls and best-effort CAT release are software controls, not an independent RF interlock. A tab crash, suspended event loop, unplug, or host failure can prevent release from reaching the radio.

Begin bench validation with a suitable dummy load, conservative radio settings, and an independent way to stop RF. Verify that every release path actually unkeys the radio: pointer/key release, cancel, duration limit, emergency RX, window blur, hidden page, page close, readback error, and serial removal. Test external PTT/VOX/keying and confirm that an unsuccessful release is not labeled confirmed RX. For scheduled digital audio, measure CAT/readback latency and actual audio timing with independent equipment. See [transmit.md](transmit.md) for the one-shot scheduling contract and evidence requirements.

## Generic radio drivers and Hamlib

RadioDesk uses a capability-based radio driver layer for direct FT-891 CAT, the explicit simulator and local Hamlib. The UI follows each driver’s supported modes, tuning bounds, readback and PTT capabilities. Hamlib reports the model configured in rigctld; this is not an independent identification of the attached radio. A successful backend readback does not establish physical hardware verification.

The optional loopback bridge exposes only structured station operations. It does not accept arbitrary Hamlib/CAT text, browser-supplied upstream addresses, radio-menu changes or power controls. Transmit is disabled at bridge startup unless the operator passes `--allow-transmit`; missing PTT setter/readback capabilities also disable it. Browser permits, fresh frequency/mode readbacks, bounded transmit time and the bridge watchdog govern supported transmit paths. Backend PTT readback can reflect Hamlib state rather than direct hardware feedback; an independent radio-side stop remains necessary.

Read [Hamlib setup](hamlib.md) for configuration, capabilities, audio routing, backend limits and hardware evidence requirements. Wider model coverage does not mean every model supports every function.
