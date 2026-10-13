import { clamp } from "../motion/math.js";
import { irisSCurve } from "../motion/irisCurves.js";
import { NOW_PLAYING_CURVES, NOW_PLAYING_MOTION } from "../motion/tokens.js";

type Color = { r: number; g: number; b: number };
type Point = readonly [number, number];

// Shipped NowPlayingEffects paths, normalized to the client area.
const LIGHT_PATHS: readonly (readonly [readonly Point[], readonly Point[]])[] = [
  [[[0.5, 0], [1, 0], [0.9, 0.3], [1, 0.7], [1, 0], [0.5, 0]],
    [[0.1, 1], [0.4, 0.9], [0.7, 1], [0.4, 0.9], [0.1, 1]]],
  [[[0, 0], [0, 0.5], [0.5, 0], [1, 0], [0.5, 0], [0, 0.5], [0, 0]],
    [[1, 0], [1, 0.7], [0.8, 1], [0.5, 1], [0.8, 1], [1, 0.7], [1, 0]]],
  [[[1, 0.2], [0.6, 0], [0.1, 0], [0.6, 0], [1, 0.2]],
    [[0, 0.5], [0.2, 0.8], [0.2, 1], [0.6, 0.9], [0.2, 1], [0.2, 0.8], [0, 0.5]]],
];

export function createMosaicColorFieldMotion(timeSeconds: number, pathIndex = 0) {
  const path = LIGHT_PATHS[Math.abs(Math.floor(pathIndex)) % LIGHT_PATHS.length];
  const phase = ((timeSeconds * 1000 / NOW_PLAYING_MOTION.mosaicLightLoop) % 1 + 1) % 1;
  return { highlight1: samplePath(path[0], phase), highlight2: samplePath(path[1], phase) };
}

/** Iris attenuation uses distance in physical WorldView pixels. */
export function mosaicLightFalloff(distance: number) {
  return clamp(500 / (700 + distance * distance * 0.005), 0, 1);
}

/** Iris Overlay uses input one as the branch-selecting base. */
export function mosaicOverlay(base: number, source: number) {
  return base <= 0.5 ? 2 * base * source : 1 - 2 * (1 - base) * (1 - source);
}

export function createMosaicLightingSampler(
  palette: readonly Color[], timeSeconds: number, width: number, height: number, dpiScale = 1,
) {
  const dpi = Math.max(1, dpiScale);
  const physicalWidth = width * dpi, physicalHeight = height * dpi;
  const motion = createMosaicColorFieldMotion(timeSeconds);
  const primary = lift(palette[0], 2.4);
  const highlight1 = lift(palette[1], 3.5);
  const highlight2 = lift(palette[2], 3.5);
  const fill = 800 / 1050;
  const x1 = motion.highlight1[0] * physicalWidth, y1 = motion.highlight1[1] * physicalHeight;
  const x2 = motion.highlight2[0] * physicalWidth, y2 = motion.highlight2[1] * physicalHeight;
  return (x: number, y: number): Color => {
    const px = x * physicalWidth, py = y * physicalHeight;
    const first = mosaicLightFalloff(Math.hypot(px - x1, py - y1));
    const second = mosaicLightFalloff(Math.hypot(px - x2, py - y2));
    const channel = (key: keyof Color) => 255 * clamp(mosaicOverlay(
      mosaicOverlay(mosaicOverlay(fill, highlight1[key] * first), highlight2[key] * second),
      primary[key]), 0, 1);
    return { r: channel("r"), g: channel("g"), b: channel("b") };
  };
}

function lift(color: Color, gain: number): Color {
  // Zone keeps its cover-derived palette; the native palette uses lighter inputs.
  return { r: clamp(color.r * gain / 255, 0, 1), g: clamp(color.g * gain / 255, 0, 1), b: clamp(color.b * gain / 255, 0, 1) };
}

function samplePath(points: readonly Point[], phase: number): Point {
  const cursor = phase * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(cursor));
  const amount = irisSCurve(cursor - index, NOW_PLAYING_CURVES.mosaicLightWeight);
  const from = points[index], to = points[index + 1];
  return [from[0] + (to[0] - from[0]) * amount, from[1] + (to[1] - from[1]) * amount];
}
