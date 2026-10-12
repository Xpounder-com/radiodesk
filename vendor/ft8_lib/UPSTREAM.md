# Vendored ft8_lib

Source: https://github.com/kgoba/ft8_lib

Pinned commit: `9fec6ca39886edbf96f4f5e71edc76da5074e871`

Retrieved on 2026-10-12. The selected `ft8`, `common` and `fft` source directories are unmodified. RadioDesk's wrapper is outside this vendor directory at `wasm/ftx-bridge.c`; its waveform synthesis adapts the upstream `demo/gen_ft8.c` algorithm.

The upstream project license is MIT; retain `LICENSE`. The bundled KISS FFT files are BSD-3-Clause, with their original source headers. `fft/COPYING` and `fft/LICENSE-BSD-3-Clause` preserve the upstream KISS FFT license (https://github.com/mborgerding/kissfft).

## Independent test recordings

- `test/wav/191111_110145.wav` and `.txt` are copied unchanged from this pinned ft8_lib commit. The expected recorded FT8 message is `GJ0KYZ RK9AX MO05`.
- `test/wav/wsjtx-ft4-000000_000002.wav` is the official WSJT-X sample, downloaded from https://downloads.sourceforge.net/project/wsjt/samples/FT4/000000_000002.wav. SHA-256: `d9e91fa04ba138a7b9f41b4103823c77ca1c3a9775101f6b14d60935bcd3813b`. This is independent of ft8_lib and RadioDesk's waveform generator. It is test data only and is not embedded in the distributed HTML. WSJT-X is licensed under GPL-3.0; this fixture's producer is the WSJT-X project. Its sample provenance is maintained here separately from the MIT ft8_lib sources. The official GNU GPL v3 text is retained in `test/LICENSE-WSJT-X-GPL-3.0`; the RadioDesk MIT notice does not relicense this upstream fixture.
