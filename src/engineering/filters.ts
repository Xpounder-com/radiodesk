import { finite, nonnegative, positive } from './complex.ts';
import type { ReactiveComponent } from './matching.ts';

interface FilterBase { order: number; impedanceOhms: number }
export type ButterworthOptions = FilterBase & (
  { kind: 'lowpass'; cutoffHz: number } |
  { kind: 'highpass'; cutoffHz: number } |
  { kind: 'bandpass'; lowerHz: number; upperHz: number }
);
export interface FilterStage {
  stage: number;
  connection: 'series' | 'shunt';
  arrangement: 'single' | 'series-resonator' | 'parallel-resonator';
  prototypeG: number;
  components: ReactiveComponent[];
}

function validate(options: ButterworthOptions): void {
  if (!Number.isInteger(options.order) || options.order < 1 || options.order > 15) throw new RangeError('order must be an integer from 1 to 15');
  positive(options.impedanceOhms, 'impedanceOhms');
  if (options.kind === 'bandpass') {
    positive(options.lowerHz, 'lowerHz'); positive(options.upperHz, 'upperHz');
    if (options.upperHz <= options.lowerHz) throw new RangeError('upperHz must be greater than lowerHz');
  } else if (options.kind === 'lowpass' || options.kind === 'highpass') positive(options.cutoffHz, 'cutoffHz');
  else throw new RangeError('Unknown Butterworth kind');
}

/** Ideal matched insertion magnitude, normalised to the passband (0 dB). */
export function butterworthResponse(options: ButterworthOptions, frequencyHz: number) {
  validate(options); nonnegative(frequencyHz, 'frequencyHz');
  let normalizedFrequency: number;
  if (options.kind === 'lowpass') normalizedFrequency = frequencyHz / options.cutoffHz;
  else if (frequencyHz === 0) normalizedFrequency = Infinity;
  else if (options.kind === 'highpass') normalizedFrequency = options.cutoffHz / frequencyHz;
  else {
    const centerHz = Math.sqrt(options.lowerHz * options.upperHz);
    normalizedFrequency = Math.abs((frequencyHz / centerHz - centerHz / frequencyHz) * centerHz / (options.upperHz - options.lowerHz));
  }
  // Stable log-domain form for very large stopband frequency ratios.
  const logPower = normalizedFrequency === 0 ? -Infinity : 2 * options.order * Math.log(normalizedFrequency);
  const logDenominator = logPower > 0 ? logPower + Math.log1p(Math.exp(-logPower)) : Math.log1p(Math.exp(logPower));
  const gainDb = -10 / Math.LN10 * logDenominator;
  return { frequencyHz, normalizedFrequency, magnitude: Math.exp(-logDenominator / 2), gainDb, attenuationDb: -gainDb };
}

/** Equal real source/load termination; series-first, ideal lumped Butterworth ladder. */
export function butterworthDesign(options: ButterworthOptions) {
  validate(options);
  const r = options.impedanceOhms;
  const stages: FilterStage[] = [];
  for (let k = 1; k <= options.order; k++) {
    const g = 2 * Math.sin((2 * k - 1) * Math.PI / (2 * options.order));
    const series = k % 2 === 1;
    const connection = series ? 'series' : 'shunt';
    let arrangement: FilterStage['arrangement'] = 'single';
    let components: ReactiveComponent[];
    if (options.kind === 'lowpass') {
      const wc = 2 * Math.PI * options.cutoffHz;
      components = series ? [{ kind: 'L', henries: r * g / wc }] : [{ kind: 'C', farads: g / (r * wc) }];
    } else if (options.kind === 'highpass') {
      const wc = 2 * Math.PI * options.cutoffHz;
      components = series ? [{ kind: 'C', farads: 1 / (r * wc * g) }] : [{ kind: 'L', henries: r / (wc * g) }];
    } else {
      const w0 = 2 * Math.PI * Math.sqrt(options.lowerHz * options.upperHz);
      const bandwidth = 2 * Math.PI * (options.upperHz - options.lowerHz);
      arrangement = series ? 'series-resonator' : 'parallel-resonator';
      components = series
        ? [{ kind: 'L', henries: r * g / bandwidth }, { kind: 'C', farads: bandwidth / (r * g * w0 * w0) }]
        : [{ kind: 'L', henries: r * bandwidth / (g * w0 * w0) }, { kind: 'C', farads: g / (r * bandwidth) }];
    }
    for (const component of components) positive(component.kind === 'L' ? component.henries : component.farads, 'component value');
    stages.push({ stage: k, connection, arrangement, prototypeG: g, components });
  }
  return {
    kind: options.kind,
    prototypeOrder: options.order,
    physicalOrder: options.kind === 'bandpass' ? 2 * options.order : options.order,
    sourceResistanceOhms: r,
    loadResistanceOhms: r,
    centerHz: options.kind === 'bandpass' ? finite(Math.sqrt(options.lowerHz * options.upperHz), 'centerHz') : options.cutoffHz,
    stages,
  };
}
