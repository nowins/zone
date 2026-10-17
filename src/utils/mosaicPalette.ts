import { NOW_PLAYING_MOTION } from "../motion/tokens.js";

export type LightingColor = { r: number; g: number; b: number; a: number };
export type LightingPalette = readonly [LightingColor, LightingColor, LightingColor];
type PaletteBytes = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];

// Zune 4.8.2345.0 NowPlayingStyles.Moods, in AllMoods order. RGB is byte-space;
// all shipped palette alphas are 255. No cover-derived gain or sRGB conversion.
export const MOSAIC_MOODS: readonly (readonly PaletteBytes[])[] = [
  [
    [[112,163,200],[248,237,68],[204,255,204]],
    [[99,78,124],[253,192,63],[252,118,190]],
    [[104,167,161],[134,241,248],[204,255,204]],
    [[213,133,57],[248,237,68],[248,149,160]],
    [[160,40,64],[248,237,68],[255,130,242]],
  ],
  [
    [[213,252,170],[252,233,104],[210,206,98]],
    [[252,243,169],[243,181,49],[252,118,190]],
    [[169,252,230],[232,243,172],[215,172,252]],
    [[210,199,221],[228,155,252],[243,85,159]],
    [[236,192,229],[251,255,154],[252,118,197]],
  ],
  [
    [[189,178,178],[243,222,78],[252,118,190]],
    [[185,181,181],[243,222,78],[195,252,128]],
    [[199,201,166],[243,222,78],[205,252,105]],
    [[195,171,186],[243,222,78],[252,121,164]],
    [[192,206,210],[136,243,229],[176,166,252]],
  ],
  [
    [[247,131,186],[247,225,35],[166,212,247]],
    [[132,247,246],[247,225,35],[153,153,255]],
    [[189,247,131],[247,225,35],[102,255,255]],
    [[189,164,214],[250,160,24],[249,47,232]],
    [[255,229,123],[181,247,103],[255,241,221]],
  ],
  [
    [[218,115,140],[248,237,68],[248,93,210]],
    [[153,181,184],[253,253,249],[97,179,192]],
    [[175,186,216],[253,253,249],[134,119,174]],
    [[175,216,180],[248,237,68],[143,253,157]],
    [[232,196,142],[248,237,68],[243,211,82]],
  ],
];

const ZERO: LightingPalette = [{r:0,g:0,b:0,a:0},{r:0,g:0,b:0,a:0},{r:0,g:0,b:0,a:0}];
export type MosaicPaletteClock = {
  moodIndex: number; elapsedMs: number; changedAt: number;
  from: LightingPalette; target: LightingPalette; palette: LightingPalette;
};

export function randomMosaicLightPath(random = Math.random) { return randomIndex(3, random); }

export function createMosaicPaletteClock(random = Math.random): MosaicPaletteClock {
  const moodIndex = randomIndex(MOSAIC_MOODS.length, random);
  const target = pickPalette(moodIndex, random);
  return { moodIndex, elapsedMs: 0, changedAt: 0, from: ZERO, target, palette: ZERO };
}

/** Ambient clocks consume visible playback time, independently of the spectrum. */
export function advanceMosaicPalette(clock: MosaicPaletteClock, deltaMs: number, playing: boolean, reduced: boolean, random = Math.random) {
  if (reduced || (!playing && clock.elapsedMs === 0)) {
    clock.from = clock.target;
    clock.palette = clock.target;
    return clock.palette;
  }
  if (!playing) return clock.palette;
  clock.elapsedMs += Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0);
  while (clock.elapsedMs - clock.changedAt >= NOW_PLAYING_MOTION.mosaicPaletteInterval) {
    clock.changedAt += NOW_PLAYING_MOTION.mosaicPaletteInterval;
    clock.from = clock.target;
    clock.target = pickPalette(clock.moodIndex, random);
  }
  const amount = Math.min(1, (clock.elapsedMs - clock.changedAt) / NOW_PLAYING_MOTION.mosaicPaletteTransition);
  clock.palette = clock.from.map((from, index) => {
    const to = clock.target[index];
    return { r: from.r + (to.r - from.r) * amount, g: from.g + (to.g - from.g) * amount,
      b: from.b + (to.b - from.b) * amount, a: from.a + (to.a - from.a) * amount };
  }) as unknown as LightingPalette;
  return clock.palette;
}

function pickPalette(mood: number, random: () => number): LightingPalette {
  const palettes = MOSAIC_MOODS[mood];
  return palettes[randomIndex(palettes.length, random)].map(([r,g,b]) => ({r,g,b,a:1})) as unknown as LightingPalette;
}
function randomIndex(count: number, random: () => number) {
  return Math.min(count - 1, Math.max(0, Math.floor(random() * count)));
}

export type MosaicLightClip = {
  image: string; pathIndex: number; elapsedMs: number; changedAt: number;
  from: LightingPalette; target: LightingPalette; palette: LightingPalette;
};
export type MosaicLightClips = { current: MosaicLightClip | null; previous: MosaicLightClip | null };

/** A new photograph owns a new path and a zero-to-palette RGBA entrance. */
export function advanceMosaicLightClips(clips: MosaicLightClips, current: string | null, previous: string | null,
  target: LightingPalette, deltaMs: number, playing: boolean, reduced: boolean, random = Math.random) {
  for (const clip of [clips.current, clips.previous]) {
    if (!clip) continue;
    if (playing && !reduced) clip.elapsedMs += Math.max(0, deltaMs);
    if (clip.target !== target) {
      clip.from = clip.target;
      clip.target = target;
      clip.changedAt = clip.elapsedMs;
    }
    if (reduced) clip.from = target;
    clip.palette = reduced ? target : blendPalette(clip.from, target,
      Math.min(1, (clip.elapsedMs - clip.changedAt) / NOW_PLAYING_MOTION.mosaicPaletteTransition));
  }
  if (clips.current?.image !== current) {
    clips.previous = clips.current;
    clips.current = current ? { image: current, pathIndex: randomMosaicLightPath(random), elapsedMs: 0,
      changedAt: 0, from: reduced ? target : ZERO, target, palette: reduced ? target : ZERO } : null;
  }
  if (!previous) clips.previous = null;
}

function blendPalette(from: LightingPalette, target: LightingPalette, amount: number): LightingPalette {
  return from.map((color, index) => {
    const to = target[index];
    return { r: color.r + (to.r - color.r) * amount, g: color.g + (to.g - color.g) * amount,
      b: color.b + (to.b - color.b) * amount, a: color.a + (to.a - color.a) * amount };
  }) as unknown as LightingPalette;
}
