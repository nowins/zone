import type { AlbumGroup } from "../types";
import { clamp, smoothstep } from "../motion/math.js";

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

export type MosaicColorFieldMotion = {
  angle: number;
  offsetX: number;
  offsetY: number;
  bend: number;
};

export type MosaicTile = {
  albumIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  seed: number;
  flipDelay: number;
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
const CANVAS_TILE_PATTERN = [3, 1, 2, 1, 2, 1, 3, 2, 1, 4, 1, 2, 1, 3, 1, 2, 1, 1, 2, 3];

export function buildCanvasMosaicTiles(width: number, height: number, albums: AlbumGroup[]) {
  const sourceLength = Math.max(albums.length, 1);
  const overflowX = Math.max(80, width * 0.1);
  const overflowY = Math.max(64, height * 0.1);
  const cell = clamp(Math.round(width / 20), 52, 108);
  const columns = Math.ceil((width + overflowX * 2) / cell);
  const rows = Math.ceil((height + overflowY * 2) / cell);
  const occupied = new Set<string>();
  const tiles: MosaicTile[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (occupied.has(cellKey(column, row))) continue;

      let span = CANVAS_TILE_PATTERN[(row * 11 + column * 5 + tiles.length) % CANVAS_TILE_PATTERN.length];
      span = Math.min(span, columns - column, rows - row);
      while (span > 1 && !canOccupy(column, row, span, span, columns, rows, occupied)) span -= 1;
      if (!canOccupy(column, row, span, span, columns, rows, occupied)) continue;

      markOccupied(column, row, span, span, occupied);
      const seed = seededNoise(column * 37 + row * 91 + tiles.length * 17);
      tiles.push({
        albumIndex: (tiles.length * 7 + Math.floor(tiles.length / 4)) % sourceLength,
        x: column * cell - overflowX,
        y: row * cell - overflowY,
        width: span * cell,
        height: span * cell,
        seed,
        flipDelay: 5_200 + seededNoise(tiles.length * 29 + 13) * 4_800,
      });
    }
  }

  return tiles;
}

export function createMosaicMotion(timeSeconds: number): MosaicMotion {
  return {
    driftX: Math.sin(timeSeconds * 0.055) * 16 + Math.sin(timeSeconds * 0.021 + 1.3) * 7,
    driftY: Math.cos(timeSeconds * 0.047 + 0.6) * 10 + Math.sin(timeSeconds * 0.018) * 5,
    scale: 1.025 + Math.sin(timeSeconds * 0.039 + 0.4) * 0.006 + Math.sin(timeSeconds * 0.017) * 0.003,
  };
}

export function mosaicTileRevealAmount(seed: number, elapsedMs: number, motionEnabled = true) {
  if (!motionEnabled) return 1;
  const delay = clamp(seed, 0, 1) * 620;
  const progress = clamp((elapsedMs - delay) / 260, 0, 1);
  return 1 - (1 - progress) ** 3;
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

export function createMosaicColorFieldMotion(timeSeconds: number): MosaicColorFieldMotion {
  return {
    angle:
      -0.75
      + timeSeconds * 0.09
      + Math.sin(timeSeconds * 0.17) * 0.35,
    offsetX:
      Math.sin(timeSeconds * 0.11 + 0.2) * 0.22
      + Math.sin(timeSeconds * 0.031 + 2.1) * 0.07,
    offsetY:
      Math.cos(timeSeconds * 0.083 + 1.1) * 0.18
      + Math.sin(timeSeconds * 0.027 + 0.4) * 0.06,
    bend: 0.15 + Math.sin(timeSeconds * 0.12 + 2.3) * 0.065,
  };
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
) {
  const motion = createMosaicColorFieldMotion(timeSeconds);
  return (x: number, y: number) => sampleMosaicColorFieldRgb(palette, motion, timeSeconds, x, y);
}

export function createMosaicFlipState(): MosaicFlipState {
  return {
    tileIndex: -1,
    startedAt: -Infinity,
    duration: 1300,
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
    beatPulse,
    beatPhase,
    beatConfidence,
    albums,
    time,
  }: {
    isPlaying: boolean;
    beatPulse: number;
    beatPhase: number;
    beatConfidence: number;
    albums: AlbumGroup[];
    time: number;
  },
) {
  if (tiles.length === 0) {
    resetFlipState(state, time);
    return state;
  }

  if (state.tileIndex >= 0 && time - state.startedAt > state.duration) {
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
    state.nextAt = time + 1_800 + seededNoise(tiles.length * 31 + 5) * 2_000;
    return state;
  }

  if (state.tileIndex >= 0 && time - state.startedAt <= state.duration) return state;
  if (time < state.nextAt) return state;

  const waitForBeat = beatConfidence >= 0.34 && beatPulse < 0.24 && beatPhase > 0.14;
  if (waitForBeat && time < state.nextAt + 650) return state;

  const selected = selectFlipTile(tiles, time, state.lastTileIndex);
  const tile = tiles[selected];
  const sourceLength = Math.max(1, albums.length);
  const fromAlbumIndex = positiveModulo(tile?.albumIndex ?? 0, sourceLength);
  const toAlbumIndex = selectBackAlbumIndex(albums, fromAlbumIndex, time + (tile?.seed ?? 0.5) * 47_000);
  if (toAlbumIndex === fromAlbumIndex) {
    state.nextAt = time + 5_200;
    return state;
  }
  state.tileIndex = selected;
  state.lastTileIndex = selected;
  state.fromAlbumIndex = fromAlbumIndex;
  state.toAlbumIndex = toAlbumIndex;
  state.direction = seededNoise(time * 0.0017 + selected * 19) > 0.5 ? 1 : -1;
  state.startedAt = time;
  state.duration = 560 + Math.round((tile?.seed ?? 0.5) * 160);
  state.nextAt = time + 5_200 + Math.round((tile?.seed ?? 0.5) * 4_800);
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

function sampleMosaicColorFieldRgb(
  palette: MosaicColorPalette,
  motion: MosaicColorFieldMotion,
  timeSeconds: number,
  x: number,
  y: number,
) {
  const centeredX = x - 0.5 + motion.offsetX;
  const centeredY = y - 0.5 + motion.offsetY;
  const cosine = Math.cos(motion.angle);
  const sine = Math.sin(motion.angle);
  const rotatedX = centeredX * cosine - centeredY * sine;
  const rotatedY = centeredX * sine + centeredY * cosine;
  const warpX =
    rotatedX
    + Math.sin(rotatedY * 5.2 + timeSeconds * 0.17) * motion.bend
    + Math.sin((rotatedX + rotatedY) * 3.1 - timeSeconds * 0.11) * 0.045;
  const warpY =
    rotatedY
    + Math.sin(rotatedX * 4.4 - timeSeconds * 0.13) * motion.bend * 0.72
    + Math.cos((rotatedX - rotatedY) * 2.7 + timeSeconds * 0.09) * 0.04;
  const horizontal = smoothstep(-0.52, 0.52, warpX);
  const vertical = smoothstep(-0.48, 0.5, warpY);
  // Nested shortest-arc hue interpolation changes direction at 180 degrees.
  // That branch cut produced a moving seam, especially during palette entry.
  // Cartesian interpolation stays continuous over both space and palette time;
  // the renderer's color blend still preserves the artwork's luminance.
  const upper = lerpRgb(palette[0], palette[1], horizontal);
  const lower = lerpRgb(palette[2], palette[3], 1 - horizontal);
  return lerpRgb(upper, lower, vertical);
}

function canOccupy(
  column: number,
  row: number,
  spanColumns: number,
  spanRows: number,
  columns: number,
  rows: number,
  occupied: Set<string>,
) {
  if (column + spanColumns > columns || row + spanRows > rows) return false;
  for (let y = row; y < row + spanRows; y += 1) {
    for (let x = column; x < column + spanColumns; x += 1) {
      if (occupied.has(cellKey(x, y))) return false;
    }
  }
  return true;
}

function markOccupied(column: number, row: number, spanColumns: number, spanRows: number, occupied: Set<string>) {
  for (let y = row; y < row + spanRows; y += 1) {
    for (let x = column; x < column + spanColumns; x += 1) occupied.add(cellKey(x, y));
  }
}

function cellKey(column: number, row: number) {
  return `${column}:${row}`;
}

function selectFlipTile(tiles: MosaicTile[], time: number, lastTileIndex: number) {
  const largeTiles = tiles
    .map((tile, index) => ({ tile, index }))
    .filter(({ tile }) => tile.width === tile.height && tile.width >= 104);
  const source = largeTiles.length > 0 ? largeTiles : tiles.map((tile, index) => ({ tile, index }));
  if (source.length === 1) return source[0].index;

  const selected = source[Math.floor(seededNoise(time * 0.0031 + source.length * 13) * source.length)]?.index ?? 0;
  if (selected !== lastTileIndex) return selected;
  const fallbackIndex = (source.findIndex((item) => item.index === selected) + 1) % source.length;
  return source[fallbackIndex]?.index ?? selected;
}

function selectBackAlbumIndex(albums: AlbumGroup[], fromAlbumIndex: number, seed: number) {
  const front = albums[fromAlbumIndex];
  const frontIdentity = front?.coverPath ?? front?.key;
  const candidates = albums
    .map((album, index) => ({ album, index }))
    .filter(({ album, index }) => index !== fromAlbumIndex && (album.coverPath ?? album.key) !== frontIdentity);
  if (candidates.length === 0) return fromAlbumIndex;
  return candidates[Math.floor(seededNoise(seed * 0.0023) * candidates.length)]?.index ?? fromAlbumIndex;
}

function resetFlipState(state: MosaicFlipState, time: number) {
  state.tileIndex = -1;
  state.initialized = false;
  state.nextAt = time + 2_400;
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
