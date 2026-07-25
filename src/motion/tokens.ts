import type { SpringPreset } from "./spring.js";

/** Duration scale in milliseconds, from instant feedback to chrome reveals. */
export const MOTION_DURATIONS = {
  instant: 80,
  press: 110,
  micro: 160,
  content: 220,
  page: 260,
  chrome: 700,
} as const;

export type MotionDurationName = keyof typeof MOTION_DURATIONS;

/**
 * Cubic-bezier control points [x1, y1, x2, y2] for the four core curves:
 * strong ease-out `standard` (WP7 feel), `entrance`, accelerating `exit`,
 * and `emphasis` with a slight overshoot.
 */
export const MOTION_EASINGS = {
  standard: [0.23, 1, 0.32, 1],
  entrance: [0.18, 0.88, 0.24, 1],
  exit: [0.55, 0.06, 0.68, 0.19],
  emphasis: [0.175, 0.885, 0.32, 1.275],
} as const;

export type MotionEasingName = keyof typeof MOTION_EASINGS;

/** Travel distance in px, tiered by content weight (list row -> hero cover). */
export const MOTION_DRIFT = { s: 8, m: 22, l: 48 } as const;

/** Per-item stagger step and total cap, in milliseconds. */
export const MOTION_STAGGER = { step: 24, max: 144 } as const;

export const SPRING_PRESETS = {
  // High stiffness, near-critical damping: press rebound and FLIP landing.
  snappy: { stiffness: 500, damping: 40, mass: 1 },
  // Medium stiffness, no visible oscillation: page-level elements.
  gentle: { stiffness: 180, damping: 28, mass: 1 },
  // Perceptible but restrained overshoot: confirmation feedback.
  bouncy: { stiffness: 300, damping: 16, mass: 1 },
} as const satisfies Record<string, SpringPreset>;

export type SpringPresetName = keyof typeof SPRING_PRESETS;

/** Token -> CSS custom property name mapping. */
export const cssVarName = {
  duration: (name: MotionDurationName): string => `--motion-${name}`,
  easing: (name: MotionEasingName): string => `--motion-ease-${name}`,
  drift: (name: keyof typeof MOTION_DRIFT): string => `--motion-drift-${name}`,
  stagger: (name: keyof typeof MOTION_STAGGER): string => `--motion-stagger-${name}`,
};

/**
 * How long JS-side lifecycles (navigation exit window, Presence unmount)
 * should wait while an exit plays. Under reduced motion the CSS side swaps
 * spatial exit animations for an 80ms opacity-only fade, so the JS wait
 * must shrink to the same instant tier instead of leaving a dead pause.
 * A zero-length transition stays zero (same-page navigation).
 */
export function resolveExitDurationMs(requestedMs: number, reducedMotion: boolean): number {
  if (requestedMs <= 0) return 0;
  return reducedMotion ? MOTION_DURATIONS.instant : requestedMs;
}

function cubicBezierCss(points: readonly [number, number, number, number]): string {
  const [x1, y1, x2, y2] = points;
  return `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`;
}

/**
 * Writes every token onto `root` as a CSS custom property
 * (`--motion-instant: 80ms`, `--motion-ease-standard: cubic-bezier(...)`,
 * `--motion-drift-s: 8px`, ...). Idempotent: it only ever sets the same
 * values, so calling it on every app start is safe. The DOM is touched
 * inside this function only, never at module scope.
 */
export function applyMotionTokens(root: HTMLElement = document.documentElement): void {
  const { style } = root;
  for (const name of Object.keys(MOTION_DURATIONS) as MotionDurationName[]) {
    style.setProperty(cssVarName.duration(name), `${MOTION_DURATIONS[name]}ms`);
  }
  for (const name of Object.keys(MOTION_EASINGS) as MotionEasingName[]) {
    style.setProperty(cssVarName.easing(name), cubicBezierCss(MOTION_EASINGS[name]));
  }
  for (const name of Object.keys(MOTION_DRIFT) as (keyof typeof MOTION_DRIFT)[]) {
    style.setProperty(cssVarName.drift(name), `${MOTION_DRIFT[name]}px`);
  }
  for (const name of Object.keys(MOTION_STAGGER) as (keyof typeof MOTION_STAGGER)[]) {
    style.setProperty(cssVarName.stagger(name), `${MOTION_STAGGER[name]}ms`);
  }
}
