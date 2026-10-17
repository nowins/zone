import { clamp } from "./math.js";

/** Iris scalar Bezier has six ordinate controls [0, 0, h1, h2, 1, 1]. */
export function irisBezier(time: number, handle1: number, handle2: number): number {
  const t = clamp(time, 0, 1);
  const remaining = 1 - t;
  return 10 * remaining ** 3 * t ** 2 * handle1
    + 10 * remaining ** 2 * t ** 3 * handle2
    + 5 * remaining * t ** 4 + t ** 5;
}

/** Normalized Iris exponential; its base is the protocol's positive weight. */
export function irisExponential(time: number, weight: number): number {
  const t = clamp(time, 0, 1);
  if (t === 0 || t === 1 || weight === 1 || !Number.isFinite(weight) || weight <= 0) return t;
  const logarithm = Math.log(weight);
  // expm1 retains the linear limit near one. The positive-log branch also
  // avoids overflow for large finite protocol weights.
  return logarithm > 0
    ? Math.exp(logarithm * (t - 1)) * -Math.expm1(-logarithm * t) / -Math.expm1(-logarithm)
    : Math.expm1(logarithm * t) / Math.expm1(logarithm);
}

/** Iris Logarithmic evaluates the exponential with the reciprocal weight. */
export function irisLogarithmic(time: number, weight: number): number {
  return irisExponential(time, 1 / weight);
}

/** Mirrored exponential halves recovered from the native SCurve evaluator. */
export function irisSCurve(time: number, weight: number): number {
  const t = clamp(time, 0, 1);
  return t < 0.5
    ? 0.5 * irisExponential(t * 2, weight)
    : 0.5 + 0.5 * irisExponential(t * 2 - 1, 1 / weight);
}

/** Native EaseIn joins a linear lead to a reciprocal exponential tail. */
export function irisEaseIn(time: number, weight: number, handle: number): number {
  const t = clamp(time, 0, 1);
  const h = clamp(handle, 0, 1);
  if (t === 0 || t === 1 || h === 1) return t;
  const distance = (1 - irisExponential(0.99, weight)) * h;
  const join = distance / ((1 - h) * 0.01 + distance);
  return t < h
    ? join * t / h
    : join + (1 - join) * irisLogarithmic((t - h) / (1 - h), weight);
}
