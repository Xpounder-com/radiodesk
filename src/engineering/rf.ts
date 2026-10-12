import { add, assertComplex, complex, divide, finite, magnitude, nonnegative, positive, scale, subtract } from './complex.ts';
import type { Complex } from './complex.ts';

export const SPEED_OF_LIGHT_MPS = 299_792_458;
export type Load = Complex | 'open' | 'short';

/** Voltage-wave reflection against a positive, real reference impedance. */
export function reflectionCoefficient(loadOhms: Load, referenceOhms = 50): Complex {
  positive(referenceOhms, 'referenceOhms');
  if (loadOhms === 'open') return complex(1);
  if (loadOhms === 'short') return complex(-1);
  assertComplex(loadOhms, 'loadOhms');
  nonnegative(loadOhms.re, 'load resistance');
  return divide(subtract(loadOhms, complex(referenceOhms)), add(loadOhms, complex(referenceOhms)));
}

export function reflectionMetrics(loadOhms: Load, referenceOhms = 50) {
  const gamma = reflectionCoefficient(loadOhms, referenceOhms);
  const rho = Math.min(1, magnitude(gamma));
  const reflectedPowerFraction = rho * rho;
  return {
    gamma,
    magnitude: rho,
    phaseDegrees: Math.atan2(gamma.im, gamma.re) * 180 / Math.PI,
    vswr: rho === 1 ? Infinity : (1 + rho) / (1 - rho),
    returnLossDb: rho === 0 ? Infinity : -20 * Math.log10(rho),
    reflectedPowerFraction,
    acceptedPowerFraction: 1 - reflectedPowerFraction,
    mismatchLossDb: rho === 1 ? Infinity : -10 * Math.log10(1 - reflectedPowerFraction),
  };
}

export interface TransmissionLineOptions {
  loadOhms: Load;
  characteristicOhms: number;
  frequencyHz: number;
  lengthMeters: number;
  velocityFactor: number;
  /** Matched, one-way attenuation over the entire line at frequencyHz. */
  attenuationDb?: number;
}

/** Uniform-line transform using a real Z0 and a specified one-way attenuation. */
export function transmissionLineInput(options: TransmissionLineOptions) {
  const { loadOhms, characteristicOhms, frequencyHz, lengthMeters, velocityFactor } = options;
  positive(characteristicOhms, 'characteristicOhms');
  positive(frequencyHz, 'frequencyHz');
  nonnegative(lengthMeters, 'lengthMeters');
  positive(velocityFactor, 'velocityFactor');
  if (velocityFactor > 1) throw new RangeError('velocityFactor must not exceed 1');
  const attenuationDb = nonnegative(options.attenuationDb ?? 0, 'attenuationDb');
  const wavelengthMeters = SPEED_OF_LIGHT_MPS * velocityFactor / frequencyHz;
  const electricalLengthRadians = 2 * Math.PI * lengthMeters / wavelengthMeters;
  const loadGamma = reflectionCoefficient(loadOhms, characteristicOhms);
  // Gamma is a voltage ratio: the reflected wave travels the line twice.
  const roundTripAmplitude = 10 ** (-attenuationDb / 10);
  const angle = -2 * electricalLengthRadians;
  const inputGamma = scale({
    re: loadGamma.re * Math.cos(angle) - loadGamma.im * Math.sin(angle),
    im: loadGamma.re * Math.sin(angle) + loadGamma.im * Math.cos(angle),
  }, roundTripAmplitude);
  const denominator = subtract(complex(1), inputGamma);
  // Roundoff around a mathematically exact open circuit is not a finite impedance.
  const isOpenCircuit = magnitude(denominator) <= 1e-14;
  return {
    inputImpedanceOhms: isOpenCircuit ? null : scale(divide(add(complex(1), inputGamma), denominator), characteristicOhms),
    isOpenCircuit,
    inputGamma,
    loadGamma,
    wavelengthMeters,
    electricalLengthDegrees: electricalLengthRadians * 180 / Math.PI,
    attenuationDb,
  };
}

export function wattsToDbm(watts: number): number {
  nonnegative(watts, 'watts');
  return watts === 0 ? -Infinity : 10 * Math.log10(watts) + 30;
}

export function dbmToWatts(dbm: number): number {
  if (dbm === -Infinity) return 0;
  finite(dbm, 'dbm');
  return finite(10 ** ((dbm - 30) / 10), 'converted watts');
}

export function voltageRmsToWatts(voltageRms: number, resistanceOhms: number): number {
  nonnegative(voltageRms, 'voltageRms'); positive(resistanceOhms, 'resistanceOhms');
  return finite(voltageRms ** 2 / resistanceOhms, 'power');
}

export function wattsToVoltageRms(watts: number, resistanceOhms: number): number {
  nonnegative(watts, 'watts'); positive(resistanceOhms, 'resistanceOhms');
  return finite(Math.sqrt(watts * resistanceOhms), 'voltage');
}

export function lcResonanceHz(inductanceHenries: number, capacitanceFarads: number): number {
  positive(inductanceHenries, 'inductanceHenries'); positive(capacitanceFarads, 'capacitanceFarads');
  return finite(1 / (2 * Math.PI * Math.sqrt(inductanceHenries * capacitanceFarads)), 'resonanceHz');
}

export function inductorReactanceOhms(frequencyHz: number, inductanceHenries: number): number {
  positive(frequencyHz, 'frequencyHz'); nonnegative(inductanceHenries, 'inductanceHenries');
  return finite(2 * Math.PI * frequencyHz * inductanceHenries, 'reactance');
}

export function capacitorReactanceOhms(frequencyHz: number, capacitanceFarads: number): number {
  positive(frequencyHz, 'frequencyHz'); positive(capacitanceFarads, 'capacitanceFarads');
  return finite(-1 / (2 * Math.PI * frequencyHz * capacitanceFarads), 'reactance');
}

/** Matched feedline attenuation. Does not add an SWR multiplier. */
export function feedlineLoss(lengthMeters: number, attenuationDbPer100Meters: number, inputWatts = 100) {
  nonnegative(lengthMeters, 'lengthMeters');
  nonnegative(attenuationDbPer100Meters, 'attenuationDbPer100Meters');
  nonnegative(inputWatts, 'inputWatts');
  const lossDb = finite(attenuationDbPer100Meters * (lengthMeters / 100), 'total lossDb');
  const efficiency = 10 ** (-lossDb / 10);
  return { lossDb, efficiency, outputWatts: inputWatts * efficiency, dissipatedWatts: inputWatts * (1 - efficiency) };
}

/** Optional cable fit: A*sqrt(fMHz) + B*fMHz in dB per 100 m. Supply manufacturer-derived coefficients. */
export function feedlineAttenuationDbPer100Meters(frequencyHz: number, conductorCoefficient: number, dielectricCoefficient: number): number {
  positive(frequencyHz, 'frequencyHz');
  nonnegative(conductorCoefficient, 'conductorCoefficient'); nonnegative(dielectricCoefficient, 'dielectricCoefficient');
  const frequencyMHz = frequencyHz / 1e6;
  return finite(conductorCoefficient * Math.sqrt(frequencyMHz) + dielectricCoefficient * frequencyMHz, 'attenuation');
}

/** Physical starting lengths only; does not calculate pattern, gain, bandwidth, or impedance. */
export function antennaLengths(frequencyHz: number, dipoleShorteningFactor = 142.6464e6 / (SPEED_OF_LIGHT_MPS / 2), loopLengthFactor = 1) {
  positive(frequencyHz, 'frequencyHz'); positive(dipoleShorteningFactor, 'dipoleShorteningFactor');
  positive(loopLengthFactor, 'loopLengthFactor');
  if (dipoleShorteningFactor > 1) throw new RangeError('dipoleShorteningFactor must not exceed 1');
  const wavelengthMeters = finite(SPEED_OF_LIGHT_MPS / frequencyHz, 'wavelengthMeters');
  const dipoleTotalMeters = wavelengthMeters / 2 * dipoleShorteningFactor;
  const fullWaveLoopPerimeterMeters = finite(wavelengthMeters * loopLengthFactor, 'fullWaveLoopPerimeterMeters');
  return {
    wavelengthMeters,
    dipoleTotalMeters,
    dipoleLegMeters: dipoleTotalMeters / 2,
    quarterWaveVerticalMeters: dipoleTotalMeters / 2,
    fullWaveLoopPerimeterMeters,
    squareLoopSideMeters: fullWaveLoopPerimeterMeters / 4,
    circularLoopDiameterMeters: fullWaveLoopPerimeterMeters / Math.PI,
    smallLoopMaximumPerimeterMeters: wavelengthMeters / 10,
    dipoleShorteningFactor,
    loopLengthFactor,
  };
}
