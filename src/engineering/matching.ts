import { add, assertComplex, complex, nonnegative, positive, reciprocal } from './complex.ts';
import type { Complex } from './complex.ts';

export type ReactiveComponent = { kind: 'L'; henries: number } | { kind: 'C'; farads: number };
export interface LMatchSolution {
  /** Elements listed when travelling from source to load. */
  topology: 'series-shunt' | 'shunt-series';
  seriesReactanceOhms: number;
  shuntSusceptanceSiemens: number;
  series: ReactiveComponent | null;
  shunt: ReactiveComponent | null;
  frequencyHz: number;
  inputImpedanceOhms: Complex;
}

function seriesComponent(reactance: number, omega: number): ReactiveComponent | null {
  if (reactance === 0) return null;
  return reactance > 0 ? { kind: 'L', henries: reactance / omega } : { kind: 'C', farads: -1 / (omega * reactance) };
}

function shuntComponent(susceptance: number, omega: number): ReactiveComponent | null {
  if (susceptance === 0) return null;
  return susceptance > 0 ? { kind: 'C', farads: susceptance / omega } : { kind: 'L', henries: -1 / (omega * susceptance) };
}

/** Re-evaluate an ideal matching circuit independently of the synthesis equations. */
export function matchingNetworkInput(loadOhms: Complex, topology: LMatchSolution['topology'], seriesReactanceOhms: number, shuntSusceptanceSiemens: number): Complex {
  assertComplex(loadOhms, 'loadOhms');
  nonnegative(loadOhms.re, 'load resistance');
  assertComplex(complex(seriesReactanceOhms, shuntSusceptanceSiemens), 'matching values');
  if (topology === 'series-shunt') return add(complex(0, seriesReactanceOhms), reciprocal(add(reciprocal(loadOhms), complex(0, shuntSusceptanceSiemens))));
  if (topology === 'shunt-series') return reciprocal(add(reciprocal(add(loadOhms, complex(0, seriesReactanceOhms))), complex(0, shuntSusceptanceSiemens)));
  throw new RangeError('Unknown matching topology');
}

/** All ideal two-reactance L matches to a real source resistance; complex passive loads supported. */
export function lMatch(sourceResistanceOhms: number, loadOhms: Complex, frequencyHz: number): LMatchSolution[] {
  positive(sourceResistanceOhms, 'sourceResistanceOhms'); positive(frequencyHz, 'frequencyHz');
  assertComplex(loadOhms, 'loadOhms'); positive(loadOhms.re, 'load resistance');
  const omega = 2 * Math.PI * frequencyHz;
  const solutions: LMatchSolution[] = [];
  function append(topology: LMatchSolution['topology'], x: number, b: number) {
    // Avoid negative zero in descriptions and skip an identical degenerate root.
    x = x === 0 ? 0 : x; b = b === 0 ? 0 : b;
    if (solutions.some((s) => s.topology === topology && s.seriesReactanceOhms === x && s.shuntSusceptanceSiemens === b)) return;
    solutions.push({ topology, seriesReactanceOhms: x, shuntSusceptanceSiemens: b, series: seriesComponent(x, omega), shunt: shuntComponent(b, omega), frequencyHz, inputImpedanceOhms: matchingNetworkInput(loadOhms, topology, x, b) });
  }
  const admittance = reciprocal(loadOhms);
  // Shunt at the load: force Re(1/(G+jB)) = Rs, then cancel its reactance.
  const discriminantB = admittance.re / sourceResistanceOhms - admittance.re ** 2;
  if (discriminantB >= 0) {
    const root = Math.sqrt(discriminantB);
    for (const sign of [1, -1]) {
      const totalB = sign * root;
      append('series-shunt', totalB * sourceResistanceOhms / admittance.re, totalB - admittance.im);
    }
  }
  // Shunt at the source: force Re(1/(Rl+jX)) = 1/Rs.
  const discriminantX = loadOhms.re * (sourceResistanceOhms - loadOhms.re);
  if (discriminantX >= 0) {
    const root = Math.sqrt(discriminantX);
    for (const sign of [1, -1]) {
      const totalX = sign * root;
      append('shunt-series', totalX - loadOhms.im, totalX / (loadOhms.re * sourceResistanceOhms));
    }
  }
  return solutions;
}
