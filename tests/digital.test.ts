import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWav } from '../src/audio/wav.ts';
import { encodeMorse, decodeMorse, morseTiming, generateCwWav, decodeCwAudio, MorseKeyDecoder } from '../src/digital/morse.ts';
import { encodeBaudot, decodeBaudot, rttyTiming, generateRttyWav, decodeRttyAudio } from '../src/digital/rtty.ts';

test('Morse text uses explicit word boundaries and rejects unsupported characters', () => {
  assert.equal(encodeMorse('CQ TEST 73'), '-.-. --.- / - . ... - / --... ...--');
  assert.equal(decodeMorse('... --- ... / --... ...--'), 'SOS 73');
  assert.equal(decodeMorse('·− −···'), 'AB');
  assert.equal(decodeMorse('........'), '�'); assert.throws(() => encodeMorse('好'), /Unsupported/);
});

test('PARIS is exactly 50 timing units at the reference speed including word gap', () => {
  const events = morseTiming('PARIS', 20);
  assert.equal(events.reduce((sum, event) => sum + event.units, 0), 50);
  assert.equal(events.reduce((sum, event) => sum + event.durationMs, 0), 3000);
  const slow = morseTiming('PARIS', 20, 10);
  assert.ok(Math.abs(slow.reduce((sum, event) => sum + event.durationMs, 0) - 6000) < 1e-9);
  assert.throws(() => morseTiming('CQ', 20, 25), /effective WPM/);
});

test('key timing decoder distinguishes dots, dashes, letters and words', () => {
  const decoder = new MorseKeyDecoder(20); let time = 0;
  for (const event of morseTiming('CQ 73', 20)) {
    if (event.keyed) { decoder.key(true, time); time += event.durationMs; decoder.key(false, time); }
    else { time += event.durationMs; decoder.tick(time); }
  }
  assert.equal(decoder.finish(), 'CQ 73');
});

test('offline CW practice WAV decodes under standard and Farnsworth timing', () => {
  for (const farnsworthWpm of [20, 10]) {
    const options = { wpm: 20, farnsworthWpm, toneHz: 700, sampleRate: 16000 };
    const wav = decodeWav(generateCwWav('CQ TEST 73', options));
    assert.equal(decodeCwAudio(wav.samples, wav.sampleRate, options), 'CQ TEST 73');
  }
});

test('ITA2 shifts preserve letters and figures and bits are LSB-first', () => {
  assert.deepEqual(encodeBaudot('A3'), [31, 3, 27, 1]);
  assert.equal(decodeBaudot(encodeBaudot('CQ CQ DE N0CALL 599 73')), 'CQ CQ DE N0CALL 599 73');
  assert.throws(() => encodeBaudot('£'), /Unsupported international ITA2/);
  assert.deepEqual(rttyTiming('E').slice(1, 8), [{ mark: false, units: 1 }, ...Array.from({ length: 5 }, () => ({ mark: true, units: 1 })), { mark: true, units: 1.5 }]);
});

test('fixed-setting RTTY WAV demodulates generated phase-continuous audio', () => {
  for (const reverse of [false, true]) {
    const options = { sampleRate: 16000, baud: 45.45, markHz: 2125, shiftHz: 170, reverse };
    const wav = decodeWav(generateRttyWav('CQ DE N0CALL 599 73', options));
    assert.equal(decodeRttyAudio(wav.samples, wav.sampleRate, options), 'CQ DE N0CALL 599 73');
  }
});
