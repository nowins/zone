import { MOTION_EASINGS } from "./tokens.js";

const NEWTON_ITERATIONS = 8;
const NEWTON_MIN_SLOPE = 1e-6;
const SOLVE_PRECISION = 1e-7;
const BISECTION_MAX_ITERATIONS = 40;

function curveA(a1: number, a2: number): number {
  return 1 - 3 * a2 + 3 * a1;
}

function curveB(a1: number, a2: number): number {
  return 3 * a2 - 6 * a1;
}

function curveC(a1: number): number {
  return 3 * a1;
}

function sampleCurve(a1: number, a2: number, t: number): number {
  return ((curveA(a1, a2) * t + curveB(a1, a2)) * t + curveC(a1)) * t;
}

function sampleCurveSlope(a1: number, a2: number, t: number): number {
  return (3 * curveA(a1, a2) * t + 2 * curveB(a1, a2)) * t + curveC(a1);
}

/**
 * Builds an evaluator for the CSS cubic-bezier(x1, y1, x2, y2) timing
 * function: input t in [0, 1] (time fraction), output progress y. Solves
 * the parametric x curve with Newton-Raphson and falls back to bisection
 * when the slope flattens. Assumes x control points stay within [0, 1].
 */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (t: number) => number {
  if (x1 === y1 && x2 === y2) {
    return (t: number) => t;
  }

  function solveT(x: number): number {
    let t = x;
    for (let i = 0; i < NEWTON_ITERATIONS; i += 1) {
      const error = sampleCurve(x1, x2, t) - x;
      if (Math.abs(error) < SOLVE_PRECISION) return t;
      const slope = sampleCurveSlope(x1, x2, t);
      if (Math.abs(slope) < NEWTON_MIN_SLOPE) break;
      t -= error / slope;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < BISECTION_MAX_ITERATIONS; i += 1) {
      const value = sampleCurve(x1, x2, t);
      if (Math.abs(value - x) < SOLVE_PRECISION) break;
      if (value < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  }

  return (progress: number) => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    return sampleCurve(y1, y2, solveT(progress));
  };
}

/** Ready-made evaluators for the shared easing tokens. */
export const MOTION_TWEENS: Record<MotionEasingKey, (t: number) => number> = {
  standard: cubicBezier(...MOTION_EASINGS.standard),
  entrance: cubicBezier(...MOTION_EASINGS.entrance),
  exit: cubicBezier(...MOTION_EASINGS.exit),
  emphasis: cubicBezier(...MOTION_EASINGS.emphasis),
  dissolve: cubicBezier(...MOTION_EASINGS.dissolve),
  navigation: cubicBezier(...MOTION_EASINGS.navigation),
};

type MotionEasingKey = keyof typeof MOTION_EASINGS;
