import test from 'node:test';
import assert from 'node:assert/strict';
import { antennaLengths, butterworthDesign, butterworthResponse, capacitorReactanceOhms, complex, dbmToWatts, divide, feedlineAttenuationDbPer100Meters, feedlineLoss, inductorReactanceOhms, lcResonanceHz, lMatch, reflectionMetrics, SPEED_OF_LIGHT_MPS, transmissionLineInput, voltageRmsToWatts, wattsToDbm, wattsToVoltageRms } from '../src/engineering/index.ts';
import type { ButterworthOptions, ReactiveComponent } from '../src/engineering/index.ts';

function near(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`);
}

test('complex division and degenerate operands', () => {
  assert.deepEqual(divide(complex(3, 4), complex(1, -2)), complex(-1, 2));
  assert.deepEqual(divide(complex(1e200, 1e200), complex(1e200, -1e200)), complex(0, 1));
  assert.throws(() => divide(complex(1), complex(0)), RangeError);
  assert.throws(() => complex(NaN), RangeError);
});

test('matched, resistive and reactive load reflection reference values', () => {
  const matched = reflectionMetrics(complex(50));
  near(matched.vswr, 1); assert.equal(matched.returnLossDb, Infinity);
  const doubled = reflectionMetrics(complex(100));
  near(doubled.gamma.re, 1 / 3); near(doubled.gamma.im, 0);
  near(doubled.vswr, 2); near(doubled.returnLossDb, 9.542425094393248);
  near(doubled.reflectedPowerFraction, 1 / 9); near(doubled.mismatchLossDb, 0.5115252244738128);
  const reactive = reflectionMetrics(complex(50, 50));
  near(reactive.gamma.re, 0.2); near(reactive.gamma.im, 0.4);
  near(reactive.magnitude, Math.sqrt(0.2)); near(reactive.acceptedPowerFraction, 0.8);
  for (const load of ['open', 'short'] as const) {
    const metrics = reflectionMetrics(load);
    assert.equal(metrics.vswr, Infinity); near(metrics.returnLossDb, 0);
    assert.equal(metrics.mismatchLossDb, Infinity);
  }
  assert.throws(() => reflectionMetrics(complex(-10)), RangeError);
  assert.throws(() => reflectionMetrics(complex(50), 0), RangeError);
});

test('quarter-wave transformer, half-wave repetition, open/short limits', () => {
  const frequencyHz = 10e6;
  const velocityFactor = 0.8;
  const wavelength = SPEED_OF_LIGHT_MPS * velocityFactor / frequencyHz;
  const base = { frequencyHz, velocityFactor, characteristicOhms: 50 };
  const quarter = transmissionLineInput({ ...base, loadOhms: complex(100), lengthMeters: wavelength / 4 });
  assert.ok(quarter.inputImpedanceOhms);
  near(quarter.inputImpedanceOhms.re, 25); near(quarter.inputImpedanceOhms.im, 0, 1e-10);
  const half = transmissionLineInput({ ...base, loadOhms: complex(40, 30), lengthMeters: wavelength / 2 });
  assert.ok(half.inputImpedanceOhms);
  near(half.inputImpedanceOhms.re, 40); near(half.inputImpedanceOhms.im, 30);
  const open = transmissionLineInput({ ...base, loadOhms: 'short', lengthMeters: wavelength / 4 });
  assert.equal(open.isOpenCircuit, true); assert.equal(open.inputImpedanceOhms, null);
  const short = transmissionLineInput({ ...base, loadOhms: 'open', lengthMeters: wavelength / 4 });
  assert.ok(short.inputImpedanceOhms); near(short.inputImpedanceOhms.re, 0); near(short.inputImpedanceOhms.im, 0, 1e-10);
});

test('one-way line attenuation causes twice-traversed reflection attenuation', () => {
  const result = transmissionLineInput({ loadOhms: complex(100), characteristicOhms: 50, frequencyHz: 7e6, velocityFactor: 0.66, lengthMeters: 0, attenuationDb: 3 });
  near(result.inputGamma.re, (1 / 3) * 10 ** (-0.3));
  const matched = transmissionLineInput({ loadOhms: complex(50), characteristicOhms: 50, frequencyHz: 7e6, velocityFactor: 0.66, lengthMeters: 25, attenuationDb: 10 });
  assert.deepEqual(matched.inputImpedanceOhms, complex(50));
  assert.throws(() => transmissionLineInput({ loadOhms: 'open', characteristicOhms: 50, frequencyHz: 7e6, velocityFactor: 1.1, lengthMeters: 1 }), RangeError);
});

// Independent circuit arithmetic checks synthesised component values rather than
// comparing the synthesis routine to its own intermediate impedance calculation.
type C = [number, number];
const cadd = (a: C, b: C): C => [a[0] + b[0], a[1] + b[1]];
const cmul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cinv = (a: C): C => { const d = a[0] ** 2 + a[1] ** 2; return [a[0] / d, -a[1] / d]; };
function impedance(component: ReactiveComponent | null, frequencyHz: number): C {
  if (!component) return [0, 0];
  return [0, component.kind === 'L' ? 2 * Math.PI * frequencyHz * component.henries : -1 / (2 * Math.PI * frequencyHz * component.farads)];
}

test('50 to 200 ohm L match has known lowpass and highpass values', () => {
  const solutions = lMatch(50, complex(200), 10e6);
  assert.equal(solutions.length, 2);
  const lowpass = solutions.find((s) => s.series?.kind === 'L' && s.shunt?.kind === 'C');
  assert.ok(lowpass); assert.equal(lowpass.topology, 'series-shunt');
  near(lowpass.seriesReactanceOhms, 86.60254037844386); near(lowpass.shuntSusceptanceSiemens, 0.008660254037844387);
  assert.ok(lowpass.series?.kind === 'L'); assert.ok(lowpass.shunt?.kind === 'C');
  near(lowpass.series.henries, 1.3783222385544803e-6, 1e-16);
  near(lowpass.shunt.farads, 1.3783222385544803e-10, 1e-20);
});

test('matching circuits match complex passive loads in both orientations', () => {
  for (const load of [complex(200), complex(12.5), complex(25, -30), complex(60, 90), complex(50, -75), complex(50)]) {
    const solutions = lMatch(50, load, 14.2e6);
    assert.ok(solutions.length > 0);
    for (const solution of solutions) {
      const seriesZ = impedance(solution.series, 14.2e6);
      const shuntY = solution.shunt ? cinv(impedance(solution.shunt, 14.2e6)) : [0, 0] as C;
      const loadZ: C = [load.re, load.im];
      const input = solution.topology === 'series-shunt' ? cadd(seriesZ, cinv(cadd(cinv(loadZ), shuntY))) : cinv(cadd(cinv(cadd(loadZ, seriesZ)), shuntY));
      near(input[0], 50, 1e-8); near(input[1], 0, 1e-8);
    }
  }
  assert.throws(() => lMatch(50, complex(0, 20), 14e6), RangeError);
});

test('Butterworth reference magnitudes, 3 dB edges and component values', () => {
  const lowpass = { kind: 'lowpass', order: 3, cutoffHz: 20e6, impedanceOhms: 50 } as const;
  near(butterworthResponse(lowpass, 20e6).gainDb, -3.010299956639812);
  near(butterworthResponse(lowpass, 40e6).magnitude, 1 / Math.sqrt(65));
  near(butterworthResponse(lowpass, 0).magnitude, 1);
  const design = butterworthDesign(lowpass);
  assert.equal(design.stages.length, 3);
  const first = design.stages[0]!.components[0]!;
  const second = design.stages[1]!.components[0]!;
  assert.ok(first.kind === 'L'); assert.ok(second.kind === 'C');
  near(first.henries, 397.8873577297383e-9, 1e-18);
  near(second.farads, 318.3098861837907e-12, 1e-21);
  const hp = { kind: 'highpass', order: 2, cutoffHz: 10e6, impedanceOhms: 50 } as const;
  assert.equal(butterworthResponse(hp, 0).magnitude, 0);
  near(butterworthResponse(hp, 5e6).magnitude, 1 / Math.sqrt(17));
  const bp = { kind: 'bandpass', order: 3, lowerHz: 10e6, upperHz: 20e6, impedanceOhms: 50 } as const;
  near(butterworthResponse(bp, Math.sqrt(200) * 1e6).magnitude, 1);
  near(butterworthResponse(bp, 10e6).gainDb, -3.010299956639812);
  near(butterworthResponse(bp, 20e6).gainDb, -3.010299956639812);
  assert.equal(butterworthDesign(bp).physicalOrder, 6);
  assert.throws(() => butterworthDesign({ ...lowpass, order: 2.5 }), RangeError);
  assert.throws(() => butterworthResponse({ ...bp, upperHz: 9e6 }, 5e6), RangeError);
});

function ladderMagnitude(options: ButterworthOptions, frequencyHz: number): number {
  let a: C = [1, 0], b: C = [0, 0], c: C = [0, 0], d: C = [1, 0];
  for (const stage of butterworthDesign(options).stages) {
    if (stage.connection === 'series') {
      const z = stage.components.map((v) => impedance(v, frequencyHz)).reduce(cadd, [0, 0]);
      b = cadd(cmul(a, z), b); d = cadd(cmul(c, z), d);
    } else {
      const y = stage.components.map((v) => cinv(impedance(v, frequencyHz))).reduce(cadd, [0, 0]);
      a = cadd(a, cmul(b, y)); c = cadd(c, cmul(d, y));
    }
  }
  const r = options.impedanceOhms;
  const denominator = cadd(cadd(a, d), cadd([b[0] / r, b[1] / r], [c[0] * r, c[1] * r]));
  return 2 / Math.hypot(...denominator);
}

test('synthesised LC ladders reproduce ideal matched response by ABCD analysis', () => {
  for (const order of [1, 2, 3, 5, 8]) {
    for (const options of [
      { kind: 'lowpass', order, cutoffHz: 12e6, impedanceOhms: 50 },
      { kind: 'highpass', order, cutoffHz: 12e6, impedanceOhms: 75 },
      { kind: 'bandpass', order, lowerHz: 7e6, upperHz: 14e6, impedanceOhms: 50 },
    ] satisfies ButterworthOptions[]) {
      for (const frequencyHz of [3e6, 7e6, 10e6, 12e6, 14e6, 30e6]) near(ladderMagnitude(options, frequencyHz), butterworthResponse(options, frequencyHz).magnitude, 1e-9);
    }
  }
});

test('antenna lengths distinguish empirical wire estimate from wavelength geometry', () => {
  const lengths = antennaLengths(7.2e6);
  near(lengths.dipoleTotalMeters, 19.812, 1e-10); // ARRL 468 / 7.2 = 65 feet.
  near(lengths.dipoleLegMeters, 9.906);
  near(lengths.quarterWaveVerticalMeters, 9.906);
  near(lengths.wavelengthMeters, 41.63784138888889);
  near(lengths.fullWaveLoopPerimeterMeters, lengths.wavelengthMeters);
  near(lengths.squareLoopSideMeters, lengths.wavelengthMeters / 4);
  assert.throws(() => antennaLengths(0), RangeError);
  assert.throws(() => antennaLengths(Number.MIN_VALUE), RangeError);
});

test('power, voltage, reactance, resonance and matched cable loss reference values', () => {
  near(wattsToDbm(100), 50); near(dbmToWatts(30), 1);
  assert.equal(wattsToDbm(0), -Infinity); assert.equal(dbmToWatts(-Infinity), 0);
  near(voltageRmsToWatts(10, 50), 2); near(wattsToVoltageRms(100, 50), Math.sqrt(5000));
  near(inductorReactanceOhms(10e6, 1e-6), 62.83185307179586);
  near(capacitorReactanceOhms(10e6, 100e-12), -159.15494309189535);
  near(lcResonanceHz(1e-6, 100e-12), 15_915_494.309189536, 1e-6);
  const loss = feedlineLoss(50, 6, 100);
  near(loss.lossDb, 3); near(loss.outputWatts, 50.11872336272722); near(loss.efficiency, 0.5011872336272722);
  near(loss.outputWatts + loss.dissipatedWatts, 100);
  near(feedlineAttenuationDbPer100Meters(100e6, 1.5, 0.02), 17);
  assert.throws(() => wattsToDbm(-1), RangeError);
  assert.throws(() => lcResonanceHz(1e-6, 0), RangeError);
  assert.throws(() => feedlineLoss(-10, 5), RangeError);
  assert.throws(() => feedlineLoss(1e308, 1e308), RangeError);
});
