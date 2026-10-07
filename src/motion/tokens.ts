import type { SpringPreset } from "./spring.js";

/** Duration scale in milliseconds, from instant feedback to chrome reveals. */
export const MOTION_DURATIONS = {
  instant: 80,
  press: 110,
  micro: 160,
  content: 220,
  page: 260,
  chrome: 700,
  /** Slow ambient loops (cycle-tile cross-fade); slower than chrome reveals. */
  cycle: 800,
  /** Long-lived looping loaders (Metro orbit); not a page-transition duration. */
  loader: 4500,
} as const;

/** Layered now-playing entrance and the final static Canvas frame. */
export const NOW_PLAYING_MOTION = {
  canvasSettle: 1400,
  mosaicReplace: 900,
  mosaicReplaceStagger: 240,
  nowQueue: 240,
  nowQueueDelay: 55,
  nowCard: 220,
  nowCardDelay: 220,
  coverEnter: 280,
  coverExit: 220,
  coverInfo: 180,
  coverInfoDelay: 60,
  coverHandoff: 80,
  nowStage: 1250,
} as const;

/** WP tile timing: interaction, readable live updates and staggered arrival. */
export const TILE_MOTION = {
  longPress: 550,
  firstMin: 6_000,
  firstMax: 14_000,
  intervalMin: 24_000,
  intervalMax: 48_000,
  hold: 5_000,
  peek: 600,
  flipHalf: 200,
  cellHalf: 280,
  cellMin: 8_000,
  cellMax: 18_000,
  stagger: 46,
  staggerMax: 460,
  entranceWindow: 900,
  peekEasing: [0.22, 0, 0.05, 1],
} as const;

/** Panorama depth follows real scroll distance; no idle movement. */
export const PANORAMA_MOTION = {
  titleRatio: 0.22,
  backdropRatio: 0.08,
  titleTravel: 480,
  backdropTravel: 240,
  coastMs: 160,
  velocityWindow: 80,
  scrollbarIdle: 700,
} as const;

/** Metro page movement has a readable arrival followed by a long deceleration. */
export const NAVIGATION_MOTION = {
  enter: 640, exit: 180, fade: 170,
  drift: 96, exitDrift: 64, groupDrift: 32, stagger: 46, maxGroups: 8,
  snapshotOverscanRows: 2,
} as const;

export type MotionDurationName = keyof typeof MOTION_DURATIONS;

/**
 * Cubic-bezier control points [x1, y1, x2, y2] for the shared curves:
 * strong ease-out `standard` (WP7 feel), `entrance`, accelerating `exit`,
 * and `emphasis` with a slight overshoot.
 */
export const MOTION_EASINGS = {
  standard: [0.23, 1, 0.32, 1],
  entrance: [0.18, 0.88, 0.24, 1],
  exit: [0.55, 0.06, 0.68, 0.19],
  emphasis: [0.175, 0.885, 0.32, 1.275],
  /** Slow, unattended chrome dissolution; user-triggered reveals stay snappy. */
  dissolve: [0.4, 0, 0.6, 1],
  navigation: [0.1, 0.9, 0.2, 1],
  /** Content transport starts gently and keeps a readable deceleration. */
  browse: [0.25, 0.65, 0.3, 1],
} as const;

export type MotionEasingName = keyof typeof MOTION_EASINGS;

/** Travel distance in px, tiered by content weight (list row -> hero cover). */
export const MOTION_DRIFT = { s: 8, m: 22, l: 48 } as const;

/** Per-item stagger step and total cap, in milliseconds. */
export const MOTION_STAGGER = { step: 24, max: 144 } as const;

/** One content-browsing preset for music and podcasts; navigation stays still. */
export const BROWSE_MOTION = {
  duration: 560, fade: 320, itemFade: 360, itemOpacity: 0.4,
  drift: 32, exitDrift: 16, stagger: MOTION_STAGGER.step, maxDelay: MOTION_STAGGER.max,
  exit: 260, settle: MOTION_DURATIONS.content,
  maxGroups: 12, maxItems: 48, maxRegions: 12,
  // Legacy feather consumers outside managed browsing surfaces keep this scale.
  scale: 0.96,
} as const;
/** Coarse vertical wheel signals only; fine gestures retain native momentum. */
export const SCROLL_MOTION = { coarseDelta: 50, linePixels: 32 } as const;

export const SPRING_PRESETS = {
  // High stiffness, near-critical damping: press rebound.
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
 * How long JS-side lifecycles (Presence unmount)
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
  style.setProperty("--motion-browse", `${BROWSE_MOTION.duration}ms`);
  style.setProperty("--motion-feather-scale", `${BROWSE_MOTION.scale}`);
  style.setProperty("--panorama-backdrop-travel", `${PANORAMA_MOTION.backdropTravel}px`);
  for (const name of Object.keys(MOTION_DURATIONS) as MotionDurationName[]) {
    style.setProperty(cssVarName.duration(name), `${MOTION_DURATIONS[name]}ms`);
  }
  for (const [name, value] of Object.entries(NOW_PLAYING_MOTION)) {
    style.setProperty(`--motion-${name}`, `${value}ms`);
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
