import { clamp } from "../motion/math.js";
import { irisSCurve } from "../motion/irisCurves.js";
import { NOW_PLAYING_CURVES, NOW_PLAYING_MOTION } from "../motion/tokens.js";

type Color = { r: number; g: number; b: number; a?: number };
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
  return { highlight1: samplePath(path[0], timeSeconds), highlight2: samplePath(path[1], timeSeconds) };
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
  palette: readonly Color[], timeSeconds: number, width: number, height: number, dpiScale = 1, pathIndex = 0,
) {
  const dpi = Math.max(1, dpiScale);
  const physicalWidth = width * dpi, physicalHeight = height * dpi;
  const motion = createMosaicColorFieldMotion(timeSeconds, pathIndex);
  const primary = normalize(palette[0]);
  const highlight1 = normalize(palette[1]);
  const highlight2 = normalize(palette[2]);
  const fill = 800 / 1050;
  const x1 = motion.highlight1[0] * physicalWidth, y1 = motion.highlight1[1] * physicalHeight;
  const x2 = motion.highlight2[0] * physicalWidth, y2 = motion.highlight2[1] * physicalHeight;
  return (x: number, y: number): Color => {
    const px = x * physicalWidth, py = y * physicalHeight;
    const first = mosaicLightFalloff(Math.hypot(px - x1, py - y1));
    const second = mosaicLightFalloff(Math.hypot(px - x2, py - y2));
    const channel = (key: "r" | "g" | "b") => 255 * clamp(mosaicOverlay(
      mosaicOverlay(mosaicOverlay(fill, highlight1[key] * first), highlight2[key] * second),
      primary[key]), 0, 1);
    return { r: channel("r"), g: channel("g"), b: channel("b"),
      a: clamp(fill + (palette[1].a ?? 1) * first + (palette[2].a ?? 1) * second + (palette[0].a ?? 1), 0, 1) };
  };
}

function normalize(color: Color) {
  return { r: clamp(color.r / 255, 0, 1), g: clamp(color.g / 255, 0, 1), b: clamp(color.b / 255, 0, 1) };
}

function samplePath(points: readonly Point[], timeSeconds: number): Point {
  // UIX stores float32(i / N * 90) seconds, then rounds milliseconds. Each
  // animation loops at its last keyframe, including the repeated endpoint.
  const times = points.map((_, i) => Math.floor(Math.fround(Math.fround(i / points.length)
    * (NOW_PLAYING_MOTION.mosaicLightPeriod / 1000)) * 1000 + 0.5));
  const duration = times[times.length - 1];
  const time = ((timeSeconds * 1000 % duration) + duration) % duration;
  let index = 0;
  while (index < points.length - 2 && time >= times[index + 1]) index++;
  const amount = irisSCurve((time - times[index]) / (times[index + 1] - times[index]), NOW_PLAYING_CURVES.mosaicLightWeight);
  const from = points[index], to = points[index + 1];
  return [from[0] + (to[0] - from[0]) * amount, from[1] + (to[1] - from[1]) * amount];
}
