import type { AlbumGroup } from "../types";
import { clamp, smoothstep } from "../motion/math.js";
import { irisBezier, irisEaseIn } from "../motion/irisCurves.js";
import { NOW_PLAYING_CURVES, NOW_PLAYING_MOTION } from "../motion/tokens.js";
import { createMosaicLightingSampler } from "./mosaicLighting.js";
export { createMosaicColorFieldMotion } from "./mosaicLighting.js";

export type RgbColor = {
  r: number;
  g: number;
  b: number;
};

export type MosaicColorPalette = [
  RgbColor,
  RgbColor,
  RgbColor,
  RgbColor,
];

export type MosaicTile = {
  id: string;
  albumIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  seed: number;
};

export type MosaicArtworkState<T> = {
  image: T | null;
  previous: T | null;
  startedAt: number;
};

/** Never replace decoded artwork with a pending/failed image. Finish an
 * in-flight dissolve before retargeting so rapid skips cannot flash a layer. */
export function advanceMosaicArtwork<T>(
  state: MosaicArtworkState<T>, candidate: T | null, fallback: T | null,
  time: number, duration: number, delay: number,
) {
  if (state.previous && time >= state.startedAt + duration) state.previous = null;
  if (!state.image) state.image = candidate ?? fallback;
  else if (candidate && candidate !== state.image && !state.previous) {
    state.previous = state.image;
    state.image = candidate;
    state.startedAt = time + delay;
  }
  if (duration <= 0) state.previous = null;
  return state.previous ? smoothstep(0, Math.max(1, duration), time - state.startedAt) : 1;
}

export type MosaicFlipState = {
  tileIndex: number;
  startedAt: number;
  duration: number;
  nextAt: number;
  initialized: boolean;
  lastTileIndex: number;
  fromAlbumIndex: number;
  toAlbumIndex: number;
  direction: -1 | 1;
};

export type MosaicMotion = {
  driftX: number;
  driftY: number;
  scale: number;
};

const ZUNE_BASE: RgbColor = { r: 62, g: 50, b: 44 };
const FIELD_HUE_OFFSETS = [-64, -18, 28, 72];
const MOSAIC_REVEAL_SLICES = 12;
// Recovered GridDefs geometry (Zune 4.8): 49 squares per 12 x 10 block.
// Edge squares extend into the next block's empty cells; they do not overlap.
export const MOSAIC_BLOCK_CELLS = [
  [2, 1, 3], [7, 0, 3], [10, 1, 3], [1, 5, 3],
  [5, 4, 3], [8, 4, 4], [0, 8, 3], [4, 7, 3],
  [3, 0, 1], [4, 0, 1], [5, 0, 1], [6, 0, 1], [10, 0, 1], [11, 0, 1],
  [1, 1, 1], [5, 1, 1], [6, 1, 1], [1, 2, 1], [5, 2, 1], [6, 2, 1],
  [1, 3, 1], [5, 3, 1], [6, 3, 1], [7, 3, 1], [8, 3, 1], [9, 3, 1],
  [1, 4, 1], [2, 4, 1], [3, 4, 1], [4, 4, 1], [12, 4, 1],
  [4, 5, 1], [12, 5, 1], [4, 6, 1], [12, 6, 1], [7, 7, 1], [12, 7, 1],
  [3, 8, 1], [7, 8, 1], [8, 8, 1], [9, 8, 1], [10, 8, 1], [11, 8, 1],
  [3, 9, 1], [7, 9, 1], [8, 9, 1], [9, 9, 1], [10, 9, 1], [11, 9, 1],
] as const;

export function buildCanvasMosaicTiles(width: number, height: number, albums: AlbumGroup[]) {
  const sourceLength = Math.max(albums.length, 1);
  const margin = 64;
  // Preserve the desktop grid, scaling only beyond the original block budget.
  const cell = Math.max(70, Math.ceil(Math.max((width + 144 + margin) / 96, (height + 200 + margin) / 80)));
  const columns = Math.min(8, Math.ceil((width + 144 + margin) / (12 * cell)));
  const rows = Math.min(8, Math.ceil((height + 200 + margin) / (10 * cell)));
  const tiles: MosaicTile[] = [];

  for (let row = -1; row < rows; row += 1) {
    for (let column = -1; column < columns; column += 1) {
      MOSAIC_BLOCK_CELLS.forEach(([x, y, span], index) => {
        const left = (column * 12 + x) * cell - 144;
        const top = (row * 10 + y) * cell - 200;
        const edge = span * cell;
        if (left + edge < -margin || top + edge < -margin || left > width + margin || top > height + margin) return;
        const seed = seededNoise(column * 37 + row * 91 + index * 17);
        tiles.push({
          id: `${column}:${row}:${index}`,
          albumIndex: Math.floor(seededNoise(column * 71 + row * 43 + index * 7) * sourceLength),
          x: left, y: top, width: edge, height: edge, seed,
        });
      });
    }
  }

  return tiles;
}

export function createMosaicMotion(_timeSeconds: number): MosaicMotion {
  // Native AlbumGridArt has fixed placement; only individual cells animate.
  return { driftX: 0, driftY: 0, scale: 1 };
}

export function mosaicTileRevealAmount(seed: number, elapsedMs: number, motionEnabled = true) {
  if (!motionEnabled) return 1;
  const { weight, handle } = NOW_PLAYING_CURVES.mosaicRevealAlpha;
  return irisEaseIn(mosaicTileRevealProgress(seed, elapsedMs), weight, handle);
}

/** GridShow scales independently of alpha, using the stronger native weight. */
export function mosaicTileRevealScale(seed: number, elapsedMs: number, motionEnabled = true) {
  if (!motionEnabled) return 1;
  const { weight, handle, start } = NOW_PLAYING_CURVES.mosaicRevealScale;
  return start + (1 - start) * irisEaseIn(mosaicTileRevealProgress(seed, elapsedMs), weight, handle);
}

function mosaicTileRevealProgress(seed: number, elapsedMs: number) {
  const slice = Math.min(MOSAIC_REVEAL_SLICES - 1,
    Math.floor(clamp(seed, 0, 1) * MOSAIC_REVEAL_SLICES));
  const delay = NOW_PLAYING_MOTION.mosaicRevealDelay + slice * NOW_PLAYING_MOTION.mosaicRevealStep;
  return clamp((elapsedMs - delay) / NOW_PLAYING_MOTION.mosaicReveal, 0, 1);
}

/** Two Y-axis keyframe segments and a separately timed back-face alpha tail.
 * Iris's quintic Bezier keeps the back face edge-on for the shipped 1ms hold. */
export function mosaicFlipFrame(elapsedMs: number) {
  const half = NOW_PLAYING_MOTION.mosaicTurn / 2;
  const back = elapsedMs >= half;
  const backStart = half + NOW_PLAYING_MOTION.mosaicTurnHold;
  const amount = easeMosaicBezier(back
    ? (elapsedMs - backStart) / (NOW_PLAYING_MOTION.mosaicTurn - backStart)
    : elapsedMs / half);
  const angle = (back ? amount - 1 : amount) * Math.PI / 2;
  const alpha = back
    ? easeMosaicBezier(clamp((elapsedMs - half) / (NOW_PLAYING_MOTION.mosaicTurnFade - half), 0, 1))
    : 1 - amount;
  return { back, alpha, angle, rotation: (back ? 1 + amount : amount) / 2, scaleX: Math.max(0.02, Math.cos(angle)) };
}

function easeMosaicBezier(progress: number) {
  return irisBezier(progress, ...NOW_PLAYING_CURVES.mosaicFlipHandles);
}

export function extractMosaicColorPalette(data: Uint8ClampedArray): MosaicColorPalette {
  const baseColor = averageImageColor(data);
  const hueBuckets = new Map<number, {
    count: number;
    score: number;
    r: number;
    g: number;
    b: number;
  }>();

  for (let index = 0; index + 3 < data.length; index += 4) {
    const alpha = data[index + 3] / 255;
    if (alpha < 0.5) continue;
    const color = { r: data[index], g: data[index + 1], b: data[index + 2] };
    const hsl = rgbToHsl(color);
    if (hsl.l < 0.035 || hsl.l > 0.965 || hsl.s < 0.08) continue;

    const bucketKey = Math.floor(normalizeHue(hsl.h) / 15);
    const bucket = hueBuckets.get(bucketKey) ?? { count: 0, score: 0, r: 0, g: 0, b: 0 };
    const weight = alpha * (0.35 + hsl.s * 0.65);
    bucket.count += weight;
    bucket.score += weight * (0.72 + (1 - Math.abs(hsl.l - 0.48)) * 0.28);
    bucket.r += color.r * weight;
    bucket.g += color.g * weight;
    bucket.b += color.b * weight;
    hueBuckets.set(bucketKey, bucket);
  }

  const accents = [...hueBuckets.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map((bucket) => ({
      r: bucket.r / Math.max(bucket.count, 0.001),
      g: bucket.g / Math.max(bucket.count, 0.001),
      b: bucket.b / Math.max(bucket.count, 0.001),
    }));

  return createMosaicColorPalette(baseColor, accents);
}

export function createMosaicColorPalette(baseColor: RgbColor, accents: RgbColor[] = []): MosaicColorPalette {
  const baseHsl = rgbToHsl(baseColor);
  const accentHsl = accents.map(rgbToHsl);
  const strongestAccent = accentHsl.find((color) => color.s >= 0.16);
  const anchorHue = strongestAccent?.h ?? (baseHsl.s >= 0.08 ? baseHsl.h : rgbToHsl(ZUNE_BASE).h);
  const lightness = [0.235, 0.225, 0.24, 0.23];

  return FIELD_HUE_OFFSETS.map((plannedOffset, index) => {
    const source = accentHsl[index % Math.max(1, accentHsl.length)];
    const sourceOffset = source
      ? clamp(shortestHueDistance(source.h, anchorHue), -110, 110)
      : plannedOffset;
    const hueOffset = plannedOffset * 0.74 + sourceOffset * 0.26;
    return hslToRgb({
      h: normalizeHue(anchorHue + hueOffset),
      s: clamp(0.48 + (source?.s ?? baseHsl.s) * 0.14, 0.46, 0.64),
      l: lightness[index],
    });
  }) as MosaicColorPalette;
}

export function interpolateMosaicColorPalette(
  from: MosaicColorPalette,
  to: MosaicColorPalette,
  amount: number,
): MosaicColorPalette {
  const progress = clamp(amount, 0, 1);
  return from.map((color, index) => lerpRgb(color, to[index], progress)) as MosaicColorPalette;
}

export function sampleMosaicColorField(
  palette: MosaicColorPalette,
  timeSeconds: number,
  x: number,
  y: number,
): RgbColor {
  return createMosaicColorFieldSampler(palette, timeSeconds)(x, y);
}

export function createMosaicColorFieldSampler(
  palette: MosaicColorPalette,
  timeSeconds: number,
  width = 1180,
  height = 760,
  dpiScale = 1,
) {
  return createMosaicLightingSampler(palette, timeSeconds, width, height, dpiScale);
}

export function createMosaicFlipState(): MosaicFlipState {
  return {
    tileIndex: -1,
    startedAt: -Infinity,
    duration: NOW_PLAYING_MOTION.mosaicTurnFade,
    nextAt: 0,
    initialized: false,
    lastTileIndex: -1,
    fromAlbumIndex: 0,
    toAlbumIndex: 0,
    direction: 1,
  };
}

export function updateMosaicFlipState(
  state: MosaicFlipState,
  tiles: MosaicTile[],
  {
    isPlaying,
    albums,
    time,
    canFlipTile,
    canUseAlbum,
  }: {
    isPlaying: boolean;
    albums: AlbumGroup[];
    time: number;
    canFlipTile?: (tile: MosaicTile, index: number) => boolean;
    canUseAlbum?: (index: number) => boolean;
  },
) {
  if (tiles.length === 0) {
    resetFlipState(state, time);
    return state;
  }

  if (state.tileIndex >= 0 && time - state.startedAt >= state.duration) {
    const completedTile = tiles[state.tileIndex];
    if (completedTile) completedTile.albumIndex = state.toAlbumIndex;
    state.tileIndex = -1;
  }

  // A live tile is allowed to finish its current turn after playback pauses so
  // it never snaps back to the front face. Pausing only suppresses new turns.
  if (!isPlaying) {
    if (state.tileIndex < 0) resetFlipState(state, time);
    return state;
  }

  if (!state.initialized) {
    state.initialized = true;
    state.tileIndex = -1;
    state.nextAt = time + NOW_PLAYING_MOTION.nowStage + NOW_PLAYING_MOTION.mosaicInterval;
    return state;
  }

  if (state.tileIndex >= 0 && time - state.startedAt <= state.duration) return state;
  if (time < state.nextAt) return state;

  const selected = selectFlipTile(tiles, time, state.lastTileIndex, canFlipTile);
  if (selected < 0) return state;
  const tile = tiles[selected];
  const sourceLength = Math.max(1, albums.length);
  const fromAlbumIndex = positiveModulo(tile?.albumIndex ?? 0, sourceLength);
  const toAlbumIndex = selectBackAlbumIndex(albums, fromAlbumIndex, time + (tile?.seed ?? 0.5) * 47_000, canUseAlbum);
  if (toAlbumIndex === fromAlbumIndex) {
    state.nextAt = time + NOW_PLAYING_MOTION.mosaicInterval;
    return state;
  }
  state.tileIndex = selected;
  state.lastTileIndex = selected;
  state.fromAlbumIndex = fromAlbumIndex;
  state.toAlbumIndex = toAlbumIndex;
  state.direction = 1;
  state.startedAt = time;
  state.duration = NOW_PLAYING_MOTION.mosaicTurnFade;
  state.nextAt = time + state.duration + NOW_PLAYING_MOTION.mosaicInterval;
  return state;
}

export function relativeLuminance(color: RgbColor) {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return channel(color.r) * 0.2126 + channel(color.g) * 0.7152 + channel(color.b) * 0.0722;
}

export function averageImageColor(data: Uint8ClampedArray): RgbColor {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 24) {
    const alpha = data[index + 3] / 255;
    r += data[index] * alpha;
    g += data[index + 1] * alpha;
    b += data[index + 2] * alpha;
    count += alpha;
  }
  return count > 0
    ? { r: r / count, g: g / count, b: b / count }
    : ZUNE_BASE;
}

function selectFlipTile(tiles: MosaicTile[], time: number, lastTileIndex: number,
  canFlipTile?: (tile: MosaicTile, index: number) => boolean) {
  const eligible = tiles
    .map((tile, index) => ({ tile, index }))
    .filter(({ tile, index }) => !canFlipTile || canFlipTile(tile, index));
  const source = eligible;
  if (source.length === 0) return -1;
  if (source.length === 1) return source[0].index;

  const selected = source[Math.floor(seededNoise(time * 0.0031 + source.length * 13) * source.length)]?.index ?? 0;
  if (selected !== lastTileIndex) return selected;
  const fallbackIndex = (source.findIndex((item) => item.index === selected) + 1) % source.length;
  return source[fallbackIndex]?.index ?? selected;
}

function selectBackAlbumIndex(albums: AlbumGroup[], fromAlbumIndex: number, seed: number,
  canUseAlbum?: (index: number) => boolean) {
  const front = albums[fromAlbumIndex];
  const frontIdentity = front?.coverPath ?? front?.key;
  const candidates = albums
    .map((album, index) => ({ album, index }))
    .filter(({ album, index }) => index !== fromAlbumIndex && (album.coverPath ?? album.key) !== frontIdentity
      && (!canUseAlbum || canUseAlbum(index)));
  if (candidates.length === 0) return fromAlbumIndex;
  return candidates[Math.floor(seededNoise(seed * 0.0023) * candidates.length)]?.index ?? fromAlbumIndex;
}

function resetFlipState(state: MosaicFlipState, time: number) {
  state.tileIndex = -1;
  state.initialized = false;
  state.nextAt = time + NOW_PLAYING_MOTION.mosaicInterval;
}

function seededNoise(seed: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function rgbToHsl(color: RgbColor) {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: lightness };

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;
  if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
  if (max === g) hue = (b - r) / delta + 2;
  if (max === b) hue = (r - g) / delta + 4;
  return { h: hue * 60, s: saturation, l: lightness };
}

function hslToRgb(color: { h: number; s: number; l: number }): RgbColor {
  const hue = normalizeHue(color.h) / 360;
  const saturation = clamp(color.s, 0, 1);
  const lightness = clamp(color.l, 0, 1);

  if (saturation === 0) {
    const value = lightness * 255;
    return { r: value, g: value, b: value };
  }

  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return {
    r: hueToRgb(p, q, hue + 1 / 3) * 255,
    g: hueToRgb(p, q, hue) * 255,
    b: hueToRgb(p, q, hue - 1 / 3) * 255,
  };
}

function hueToRgb(p: number, q: number, value: number) {
  let t = value;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function shortestHueDistance(from: number, to: number) {
  return ((((from - to) % 360) + 540) % 360) - 180;
}

function normalizeHue(hue: number) {
  return ((hue % 360) + 360) % 360;
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function lerpRgb(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  const progress = clamp(amount, 0, 1);
  return {
    r: from.r + (to.r - from.r) * progress,
    g: from.g + (to.g - from.g) * progress,
    b: from.b + (to.b - from.b) * progress,
  };
}
