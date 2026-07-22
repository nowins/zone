import type { AlbumGroup } from "../types";

export type RgbColor = {
  r: number;
  g: number;
  b: number;
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

export type MosaicColorSweep = {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  color: RgbColor;
  shadow: RgbColor;
};

export type MosaicMotion = {
  driftX: number;
  driftY: number;
  scale: number;
};

const ZUNE_BASE: RgbColor = { r: 62, g: 50, b: 44 };
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

export function colorToZuneTint(color: RgbColor): RgbColor {
  const input = rgbToHsl(color);
  const base = rgbToHsl(ZUNE_BASE);
  const hueDistanceToBase = shortestHueDistance(input.h, base.h);
  const hue = normalizeHue(base.h + hueDistanceToBase * 0.55);
  const saturation = clamp(input.s * 0.2 + 0.4, 0.36, 0.54);
  const lightness = clamp(input.l * 0.12 + 0.13, 0.13, 0.24);
  return hslToRgb({ h: hue, s: saturation, l: lightness });
}

export function createSlowTint(baseTint: RgbColor, timeSeconds: number): RgbColor {
  const hsl = rgbToHsl(baseTint);
  const slowDrift = Math.sin(timeSeconds * 0.052) * 12 + Math.sin(timeSeconds * 0.019 + 0.8) * 7;
  return hslToRgb({
    h: normalizeHue(hsl.h + slowDrift),
    s: clamp(hsl.s + 0.006 + Math.sin(timeSeconds * 0.033 + 1.2) * 0.024, 0.34, 0.56),
    l: clamp(hsl.l + 0.006 + Math.sin(timeSeconds * 0.027 + 0.4) * 0.012, 0.13, 0.25),
  });
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

export function lerpColor(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  const alpha = clamp(amount, 0, 1);
  return {
    r: from.r + (to.r - from.r) * alpha,
    g: from.g + (to.g - from.g) * alpha,
    b: from.b + (to.b - from.b) * alpha,
  };
}

export function createMosaicColorSweep({
  baseTint,
  timeSeconds,
  isPlaying,
}: {
  baseTint: RgbColor;
  timeSeconds: number;
  isPlaying: boolean;
}): MosaicColorSweep {
  // A roving light rather than a fixed-direction wash: the source drifts on a
  // Lissajous-like path and its hue shifts as it travels, so bright and dim
  // regions keep migrating across the wall.
  const pace = isPlaying ? 1 : 0.25;
  const t = timeSeconds * pace;
  const x = 0.5 + Math.sin(t * 0.041) * 0.34 + Math.sin(t * 0.017 + 1.2) * 0.09;
  const y = 0.44 + Math.cos(t * 0.033 + 0.7) * 0.26 + Math.sin(t * 0.012 + 2.1) * 0.07;
  const hsl = rgbToHsl(baseTint);
  const color = hslToRgb({
    h: normalizeHue(hsl.h + Math.sin(t * 0.047 + 0.5) * 16),
    s: clamp(hsl.s + 0.08, 0.34, 0.56),
    l: clamp(hsl.l + 0.045, 0.17, 0.28),
  });
  const shadow = hslToRgb({
    h: normalizeHue(hsl.h - 14),
    s: clamp(hsl.s + 0.02, 0.28, 0.48),
    l: clamp(hsl.l * 0.55, 0.06, 0.13),
  });

  return {
    x,
    y,
    radius: 0.58,
    alpha: 0.2,
    color,
    shadow,
  };
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

export function colorCss(color: RgbColor, alpha = 1) {
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${alpha})`;
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
