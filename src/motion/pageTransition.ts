import { MOTION_DURATIONS, MOTION_DRIFT } from "./tokens.js";

export type MotionPage = "quickplay" | "collection" | "nowPlaying" | "settings";

export interface PageTransition {
  kind: "pivot" | "push" | "pop";
  direction: 1 | -1;
  exitMs: number;
  enterMs: number;
  exitDriftPx: number;
  enterDriftPx: number;
  coverFlip: boolean;
}

// Peer pages in left-to-right navigation order; nowPlaying sits above them.
const PEER_PAGES: readonly MotionPage[] = ["quickplay", "collection", "settings"];

/**
 * Resolves the WP7-style choreography between two pages: peers pivot along
 * the navigation order (forward = 1), entering nowPlaying pushes on top,
 * leaving it pops back. Same-page transitions are zero-length. Durations
 * come from the micro/page token tiers. The shell consumes direction/exitMs
 * and writes the drift fields as `--motion-drift` / `--motion-exit-drift`;
 * `coverFlip` marks pairs where the views run the shared-element cover
 * flight (registered/consumed through the `cover:{trackId}` FLIP registry,
 * not through the navigation timer path).
 */
export function resolvePageTransition(from: MotionPage, to: MotionPage): PageTransition {
  if (from === to) {
    return {
      kind: "pivot",
      direction: 1,
      exitMs: 0,
      enterMs: 0,
      exitDriftPx: 0,
      enterDriftPx: 0,
      coverFlip: false,
    };
  }

  if (to === "nowPlaying") {
    return {
      kind: "push",
      direction: 1,
      exitMs: MOTION_DURATIONS.micro,
      enterMs: MOTION_DURATIONS.page,
      exitDriftPx: MOTION_DRIFT.m,
      enterDriftPx: MOTION_DRIFT.l,
      coverFlip: true,
    };
  }

  if (from === "nowPlaying") {
    return {
      kind: "pop",
      direction: -1,
      exitMs: MOTION_DURATIONS.micro,
      enterMs: MOTION_DURATIONS.page,
      exitDriftPx: MOTION_DRIFT.l,
      enterDriftPx: MOTION_DRIFT.m,
      coverFlip: true,
    };
  }

  const direction: 1 | -1 = PEER_PAGES.indexOf(to) > PEER_PAGES.indexOf(from) ? 1 : -1;
  return {
    kind: "pivot",
    direction,
    exitMs: MOTION_DURATIONS.micro,
    enterMs: MOTION_DURATIONS.page,
    exitDriftPx: MOTION_DRIFT.m,
    enterDriftPx: MOTION_DRIFT.m,
    coverFlip: false,
  };
}
