/** Rectangular complex values. Impedance values use ohms, admittance siemens. */
export interface Complex { re: number; im: number }

export function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}

export function positive(value: number, name: string): number {
  finite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be greater than zero`);
  return value;
}

export function nonnegative(value: number, name: string): number {
  finite(value, name);
  if (value < 0) throw new RangeError(`${name} must be nonnegative`);
  return value;
}

export function complex(re: number, im = 0): Complex {
  return { re: finite(re, 'real part'), im: finite(im, 'imaginary part') };
}

export function assertComplex(value: Complex, name = 'complex value'): void {
  finite(value.re, `${name} real part`);
  finite(value.im, `${name} imaginary part`);
}

export function add(a: Complex, b: Complex): Complex {
  return complex(a.re + b.re, a.im + b.im);
}

export function subtract(a: Complex, b: Complex): Complex {
  return complex(a.re - b.re, a.im - b.im);
}

export function multiply(a: Complex, b: Complex): Complex {
  return complex(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
}

export function scale(a: Complex, factor: number): Complex {
  return complex(a.re * factor, a.im * factor);
}

export function divide(a: Complex, b: Complex): Complex {
  assertComplex(a); assertComplex(b);
  // Normalising the divisor avoids squaring very large or small impedances.
  const magnitude = Math.max(Math.abs(b.re), Math.abs(b.im));
  if (magnitude === 0) throw new RangeError('Cannot divide by zero complex value');
  const br = b.re / magnitude, bi = b.im / magnitude;
  const denominator = br * br + bi * bi;
  const ar = a.re / magnitude, ai = a.im / magnitude;
  return complex((ar * br + ai * bi) / denominator, (ai * br - ar * bi) / denominator);
}

export function reciprocal(value: Complex): Complex { return divide(complex(1), value); }
export function magnitude(value: Complex): number { return Math.hypot(value.re, value.im); }
export function phaseDegrees(value: Complex): number { return Math.atan2(value.im, value.re) * 180 / Math.PI; }
