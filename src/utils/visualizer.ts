import { clamp, clampInt } from "../motion/math.js";

export type VisualizerFrame = {
  samples: number[];
  transients: number[];
  bands: number[];
  energy: number;
  bass: number;
  ambient: number;
  texture: number;
  onsetStrength: number;
  active: boolean;
};

const DEFAULT_SAMPLE_RATE = 44_100;
const BAND_EDGES = [35, 60, 95, 145, 220, 330, 500, 800, 1300, 2200, 3800, 6500, 10000];
// Interleave frequency regions across the floor rather than drawing a spectrum
// from left to right. Bass forms broad volumes; voices and percussion add
// smaller, independently moving crests. There is no time-driven idle motion.
const BAND_CENTERS = [0.43, 0.58, 0.32, 0.71, 0.22, 0.8, 0.48, 0.63, 0.15, 0.85, 0.37, 0.69];

export function createSilentVisualizerFrame(sampleCount: number): VisualizerFrame {
  return {
    samples: new Array(sampleCount).fill(0), transients: new Array(sampleCount).fill(0),
    bands: new Array(BAND_CENTERS.length).fill(0),
    energy: 0, bass: 0, ambient: 0, texture: 0, onsetStrength: 0, active: false,
  };
}

export function createAudioVisualizerFrame(
  frequencyData: Uint8Array,
  timeData: Uint8Array,
  sampleCount: number,
  sampleRate = DEFAULT_SAMPLE_RATE,
  fftSize = Math.max(timeData.length, frequencyData.length * 2),
): VisualizerFrame {
  const rms = calculateRms(timeData);
  // FFT smoothing can leave frequency bins lit after the media becomes silent.
  // Gate against actual PCM, above its byte quantization noise floor.
  const signal = clamp((rms - 0.004) / 0.026, 0, 1);
  // Byte magnitudes already span a logarithmic dB range. Cubing them before
  // the contour's own falloff nearly erased voices and acoustic instruments.
  // Keep moderate bands visible while retaining headroom for strong bass.
  const bands = BAND_CENTERS.map((_, index) => (
    averageFrequencyRange(frequencyData, sampleRate, fftSize, BAND_EDGES[index], BAND_EDGES[index + 1]) ** 1.5 * signal
  ));
  const bass = average(bands.slice(0, 3));
  const ambient = average(bands.slice(3, 8));
  const texture = average(bands.slice(8));
  const energy = clamp((rms * 1.4 + bass * 0.24 + ambient * 0.16) ** 0.85 * signal, 0, 1);
  const { samples, transients } = createSpectralContour(bands, [], sampleCount);
  return { samples, transients, bands, energy, bass, ambient, texture, onsetStrength: 0, active: energy > 0.006 };
}

// State belongs to one running music sampler. Restarting the sampler or seeking
// resets the history, so a previous song/section cannot produce a false attack.
export class AudioVisualizerAnalyzer {
  private previousBands: number[] = [];
  private envelopes: number[] = [];
  private attacks: number[] = [];
  private lastTime: number | null = null;

  update(frame: VisualizerFrame, mediaTime: number): VisualizerFrame {
    const elapsed = this.lastTime === null ? 0 : mediaTime - this.lastTime;
    const reset = this.lastTime === null || elapsed < 0 || elapsed > 0.25;
    this.lastTime = mediaTime;
    const delta = clamp(elapsed, 0, 0.08);
    this.attacks = frame.bands.map((level, index) => {
      const previous = this.previousBands[index] ?? level;
      const rise = reset || delta === 0 ? 0 : clamp((level - previous) / Math.max(0.12, previous + 0.08), 0, 1);
      return reset ? 0 : Math.max(rise, (this.attacks[index] ?? 0) * Math.exp(-delta / (index < 3 ? 0.16 : 0.085)));
    });
    this.envelopes = frame.bands.map((level, index) => {
      const previous = this.envelopes[index] ?? level;
      const tau = level > previous ? 0.025 : index < 3 ? 0.19 : 0.11;
      return reset ? level : previous + (level - previous) * (1 - Math.exp(-delta / tau));
    });
    this.previousBands = frame.bands;
    // A beat grid provides timing, not evidence of a hit. Only live spectral
    // changes can excite geometry, including late sections of a song.
    const onsetStrength = frame.active ? Math.max(...this.attacks) : 0;
    const { samples, transients } = createSpectralContour(this.envelopes, frame.active ? this.attacks : [], frame.samples.length);
    return { ...frame, samples, transients, onsetStrength };
  }
}

function createSpectralContour(bands: number[], attacks: number[], count: number) {
  const samples: number[] = [];
  const transients: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const x = index / Math.max(1, count - 1);
    let body = 0;
    let crest = 0;
    for (let band = 0; band < bands.length; band += 1) {
      const level = bands[band];
      const attack = attacks[band] ?? 0;
      const weight = band < 3 ? 1.15 : band < 8 ? 0.8 : 0.26;
      const width = band < 3 ? 0.06 + level * 0.035 + attack * 0.025 : 0.025 + level * 0.025;
      const volume = gaussian(x, BAND_CENTERS[band], width);
      // Preserve separate volumes: adding overlapping bands saturated the
      // entire middle into the same smooth arch on dense recordings.
      body = Math.max(body, volume * level ** 1.25 * weight);
      crest += gaussian(x, BAND_CENTERS[band], width * 0.62) * attack * Math.sqrt(level) * weight;
    }
    const edge = 0.28 + Math.sin(Math.PI * x) ** 0.55 * 0.72;
    samples.push((1 - Math.exp(-body * 1.65)) * 0.34 * edge);
    transients.push((1 - Math.exp(-crest * 1.8)) * edge);
  }
  return { samples, transients };
}

// Explicit reduced-motion substitute only. Runtime silence uses the zero frame.
export function createIdleVisualizerFrame(sampleCount: number, _time: number, _playHead: number): VisualizerFrame {
  return {
    ...createSilentVisualizerFrame(sampleCount),
    energy: 0.055, ambient: 0.055,
    samples: Array.from({ length: sampleCount }, (_, index) => gaussian(index / Math.max(1, sampleCount - 1), 0.5, 0.3) * 0.035),
  };
}

function averageFrequencyRange(data: Uint8Array, sampleRate: number, fftSize: number, startFrequency: number, endFrequency: number) {
  if (data.length === 0) return 0;
  const start = clampInt(Math.round(startFrequency * fftSize / sampleRate), 0, data.length - 1);
  const end = clampInt(Math.round(endFrequency * fftSize / sampleRate), start + 1, data.length);
  let total = 0;
  for (let index = start; index < end; index += 1) total += data[index];
  return total / Math.max(end - start, 1) / 255;
}

function calculateRms(data: Uint8Array) {
  let total = 0;
  for (const value of data) total += ((value - 128) / 128) ** 2;
  return Math.sqrt(total / Math.max(data.length, 1));
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function gaussian(value: number, center: number, width: number) {
  return Math.exp(-(((value - center) / width) ** 2));
}
