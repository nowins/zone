import { MOTION_DURATIONS, MOTION_DRIFT } from "./tokens.js";

export type MotionPage = "quickplay" | "collection" | "podcasts" | "nowPlaying" | "settings";

export interface PageTransition {
  kind: "pivot" | "push" | "pop";
  direction: 1 | -1;
  enterMs: number;
  enterDriftPx: number;
  coverFlip: boolean;
}

// Peer pages in left-to-right navigation order; nowPlaying sits above them.
const PEER_PAGES: readonly MotionPage[] = ["quickplay", "collection", "podcasts", "settings"];

/**
 * Resolves the WP7-style choreography between two pages: peers pivot along
 * the navigation order (forward = 1), entering nowPlaying pushes on top,
 * leaving it pops back. Same-page transitions are zero-length. Durations
 * come from the page token tier. Navigation mounts the target immediately;
 * the shell supplies direction and `--motion-drift` to its entrance.
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
      coverFlip: false,
    };
  }

  if (to === "nowPlaying") {
    return {
      kind: "push",
      direction: 1,
      enterMs: MOTION_DURATIONS.page,
      enterDriftPx: MOTION_DRIFT.l,
      coverFlip: true,
    };
  }

  if (from === "nowPlaying") {
    return {
      kind: "pop",
      direction: -1,
      enterMs: MOTION_DURATIONS.page,
      enterDriftPx: MOTION_DRIFT.m,
      coverFlip: true,
    };
  }

  const direction: 1 | -1 = PEER_PAGES.indexOf(to) > PEER_PAGES.indexOf(from) ? 1 : -1;
  return {
    kind: "pivot",
    direction,
    enterMs: MOTION_DURATIONS.page,
    enterDriftPx: MOTION_DRIFT.m,
    coverFlip: false,
  };
}
