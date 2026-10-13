import { irisLogarithmic } from "../motion/irisCurves.js";
import { clamp } from "../motion/math.js";
import { NOW_PLAYING_CURVES, NOW_PLAYING_MOTION } from "../motion/tokens.js";

export const GLOW_FFT_SIZE = 2048;
export const GLOW_BAND_COUNT = 256;
export const GLOW_DISPLAY_COUNT = 40;
export const GLOW_BASE_HEIGHT = 90;
export const GLOW_OVERLAP = 8;
export const GLOW_LEFT_INDICES = [255, 204, 179, 160, 128, 115, 102, 90, 80, 64, 51, 40, 25, 12, 10, 6, 4, 3, 2, 1] as const;
export const EMPTY_GLOW_BANDS: readonly number[] = Object.freeze(new Array<number>(GLOW_DISPLAY_COUNT).fill(0));
export type GlowLayer = "orange" | "pink";
export type GlowSprite = { x: number; width: number; height: number; alpha: number };

/** Group adjacent spectrum bytes, then select the shipped L/R spatial order.
 * The Web Audio byte scale and PCM gate are Zone adaptations, not WMP's DSP. */
export function createZuneGlowBands(
  leftFrequency: Uint8Array,
  rightFrequency: Uint8Array,
  leftPcm: Uint8Array,
  rightPcm: Uint8Array,
): number[] {
  const leftGate = pcmSignal(leftPcm), rightGate = pcmSignal(rightPcm);
  return [
    ...GLOW_LEFT_INDICES.map(index => groupedMagnitude(leftFrequency, index) * leftGate),
    ...[...GLOW_LEFT_INDICES].reverse().map(index => groupedMagnitude(rightFrequency, index) * rightGate),
  ];
}

function groupedMagnitude(data: Uint8Array, band: number): number {
  if (data.length < GLOW_BAND_COUNT) return 0;
  const first = Math.floor(band * data.length / GLOW_BAND_COUNT);
  const end = Math.floor((band + 1) * data.length / GLOW_BAND_COUNT);
  let total = 0;
  for (let index = first; index < end; index++) total += data[index];
  return total / (end - first) / 255;
}

function pcmSignal(data: Uint8Array): number {
  if (!data.length) return 0;
  let total = 0;
  for (const value of data) total += ((value - 128) / 128) ** 2;
  // Suppress smoothed FFT tails and byte-PCM quantization noise in actual silence.
  return clamp((Math.sqrt(total / data.length) - 0.004) / 0.026, 0, 1);
}

export function zuneGlowResponse(value: number, layer: GlowLayer): number {
  const input = Number.isFinite(value) ? clamp(value, 0, 1) : 0;
  return input ** (layer === "orange" ? 3 : 2);
}

export function zuneGlowSprites(levels: readonly number[], width: number): GlowSprite[] {
  const steps = GLOW_DISPLAY_COUNT + GLOW_OVERLAP;
  return Array.from({ length: GLOW_DISPLAY_COUNT }, (_, index) => {
    const level = Number.isFinite(levels[index]) ? clamp(levels[index], 0, 1) : 0;
    return { x: width * index / steps, width: width * (GLOW_OVERLAP + 1) / steps,
      height: GLOW_BASE_HEIGHT * 1.5 * level, alpha: 0.5 * level };
  });
}

/** Each layer samples on its own loop boundary and interpolates from its last
 * target. No beat prediction or wall-clock oscillation can create a signal. */
export class ZuneGlowAnimator {
  private from = [...EMPTY_GLOW_BANDS];
  private target = [...EMPTY_GLOW_BANDS];
  private started: number | null = null;
  private lastTime: number | null = null;
  private lastLevels = [...EMPTY_GLOW_BANDS];
  constructor(private readonly layer: GlowLayer) {}

  update(timeMs: number, bands: readonly number[]): readonly number[] {
    const duration = this.layer === "orange" ? NOW_PLAYING_MOTION.glowOrangeCycle : NOW_PLAYING_MOTION.glowPinkCycle;
    const weight = this.layer === "orange" ? NOW_PLAYING_CURVES.glowOrangeWeight : NOW_PLAYING_CURVES.glowPinkWeight;
    if (this.lastTime !== null && (timeMs < this.lastTime || timeMs - this.lastTime > NOW_PLAYING_MOTION.canvasSettle)) this.reset();
    this.lastTime = timeMs;
    if (this.started === null) {
      this.started = timeMs;
      this.target = EMPTY_GLOW_BANDS.map((_, index) => zuneGlowResponse(bands[index] ?? 0, this.layer));
    } else if (timeMs - this.started >= duration) {
      this.from = this.target;
      this.started += Math.floor((timeMs - this.started) / duration) * duration;
      this.target = EMPTY_GLOW_BANDS.map((_, index) => zuneGlowResponse(bands[index] ?? 0, this.layer));
    }
    const progress = irisLogarithmic((timeMs - this.started) / duration, weight);
    this.lastLevels = this.from.map((value, index) => value + (this.target[index] - value) * progress);
    return this.lastLevels;
  }

  get active(): boolean { return this.lastLevels.some(level => level > 0.00001) || this.target.some(level => level > 0); }
  reset(): void {
    this.from = [...EMPTY_GLOW_BANDS]; this.target = [...EMPTY_GLOW_BANDS]; this.lastLevels = [...EMPTY_GLOW_BANDS];
    this.started = null; this.lastTime = null;
  }
}

/** A small reusable soft-light texture. Its shape/color are a Zone drawing,
 * rather than redistributed Zune artwork or an unverified native blend. */
export function createZuneGlowTexture(layer: GlowLayer): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = 200; canvas.height = 25;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const pixels = context.createImageData(canvas.width, canvas.height);
  const rgb = layer === "orange" ? [242, 106, 32] : [238, 48, 92];
  for (let y = 0; y < canvas.height; y++) {
    const vertical = (y / (canvas.height - 1)) ** (layer === "orange" ? 1.8 : 2.6);
    for (let x = 0; x < canvas.width; x++) {
      const horizontal = Math.sin(Math.PI * x / (canvas.width - 1)) ** 1.4;
      const offset = (y * canvas.width + x) * 4;
      pixels.data.set(rgb, offset);
      pixels.data[offset + 3] = Math.round(212 * horizontal * vertical);
    }
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}
