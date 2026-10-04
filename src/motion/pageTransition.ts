import { NAVIGATION_MOTION } from "./tokens.js";

export type MotionPage = "quickplay" | "collection" | "podcasts" | "nowPlaying" | "settings";

export interface PageTransition {
  kind: "pivot" | "push" | "pop";
  direction: 1 | -1;
  enterMs: number;
  enterDriftPx: number;
  exitMs: number;
  exitDriftPx: number;
  coverFlip: boolean;
}

// Peer pages in left-to-right navigation order; nowPlaying sits above them.
const PEER_PAGES: readonly MotionPage[] = ["quickplay", "collection", "podcasts", "settings"];

/**
 * Resolves the WP7-style choreography between two pages: peers pivot along
 * the navigation order (forward = 1), entering nowPlaying pushes on top,
 * leaving it pops back. Same-page transitions are zero-length. Durations
 * come from NAVIGATION_MOTION. Navigation mounts the target immediately;
 * SurfaceTransition overlaps outgoing pixels with the grouped arrival.
 * `coverFlip` marks pairs where the views run the shared-element cover
 * flight (registered/consumed through the `cover:{trackId}` FLIP registry,
 * not through the navigation timer path).
 */
export function resolvePageTransition(from: MotionPage, to: MotionPage): PageTransition {
  if (from === to) {
    return {
      kind: "pivot",
      direction: 1,
      enterMs: 0,
      enterDriftPx: 0,
      exitMs: 0,
      exitDriftPx: 0,
      coverFlip: false,
    };
  }

  if (to === "nowPlaying") {
    return {
      kind: "push",
      direction: 1,
      enterMs: NAVIGATION_MOTION.enter,
      enterDriftPx: NAVIGATION_MOTION.drift,
      exitMs: NAVIGATION_MOTION.exit,
      exitDriftPx: NAVIGATION_MOTION.exitDrift,
      coverFlip: true,
    };
  }

  if (from === "nowPlaying") {
    return {
      kind: "pop",
      direction: -1,
      enterMs: NAVIGATION_MOTION.enter,
      enterDriftPx: NAVIGATION_MOTION.drift,
      exitMs: NAVIGATION_MOTION.exit,
      exitDriftPx: NAVIGATION_MOTION.exitDrift,
      coverFlip: true,
    };
  }

  const direction: 1 | -1 = PEER_PAGES.indexOf(to) > PEER_PAGES.indexOf(from) ? 1 : -1;
  return {
    kind: "pivot",
    direction,
    enterMs: NAVIGATION_MOTION.enter,
    enterDriftPx: NAVIGATION_MOTION.drift,
    exitMs: NAVIGATION_MOTION.exit,
    exitDriftPx: NAVIGATION_MOTION.exitDrift,
    coverFlip: false,
  };
}
