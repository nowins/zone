import { clamp, clampInt } from "../motion/math.js";

export type VisualizerFrame = {
  samples: number[];
  energy: number;
  bass: number;
  ambient: number;
  active: boolean;
};

const DEFAULT_SAMPLE_RATE = 44_100;

export function createAudioVisualizerFrame(
  frequencyData: Uint8Array,
  timeData: Uint8Array,
  sampleCount: number,
  sampleRate = DEFAULT_SAMPLE_RATE,
  fftSize = Math.max(timeData.length, frequencyData.length * 2),
): VisualizerFrame {
  const subBass = averageFrequencyRange(frequencyData, sampleRate, fftSize, 35, 72);
  const bass = averageFrequencyRange(frequencyData, sampleRate, fftSize, 72, 150);
  const lowMid = averageFrequencyRange(frequencyData, sampleRate, fftSize, 150, 520);
  const body = averageFrequencyRange(frequencyData, sampleRate, fftSize, 520, 1200);
  const texture = averageFrequencyRange(frequencyData, sampleRate, fftSize, 1800, 5200);
  const rms = calculateRms(timeData);
  const bassEnergy = clamp(Math.pow(subBass * 0.9 + bass * 0.78 + rms * 0.5, 0.86), 0, 1);
  const ambient = clamp(Math.pow(lowMid * 0.42 + body * 0.2 + rms * 0.55, 0.92), 0, 1);
  const energy = clamp(bassEnergy * 0.68 + ambient * 0.32, 0, 1);

  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const ratio = index / Math.max(sampleCount - 1, 1);
    const timeEnvelope = averageWaveEnvelope(timeData, ratio, sampleCount);
    const centerBias = 0.42 + Math.pow(Math.sin(Math.PI * ratio), 1.85) * 0.38;
    const lowShelf =
      gaussian(ratio, 0.24, 0.2) * subBass * 0.095 +
      gaussian(ratio, 0.52, 0.34) * bassEnergy * 0.145 +
      gaussian(ratio, 0.78, 0.23) * lowMid * 0.055;
    const waveformTrace = timeEnvelope * (0.025 + bassEnergy * 0.055);
    const fineMotion = texture * (0.006 + centerBias * 0.016);
    const horizon = 0.018 + energy * 0.026 + lowShelf + waveformTrace + fineMotion;
    return clamp(horizon * centerBias, 0.014, 0.38);
  });

  return {
    samples,
    energy,
    bass: bassEnergy,
    ambient,
    active: energy > 0.026 || bassEnergy > 0.035 || lowMid > 0.028,
  };
}

export function createIdleVisualizerFrame(sampleCount: number, time: number, playHead: number): VisualizerFrame {
  const energy = 0.055 + Math.sin(time * 0.28 + playHead * 0.04) * 0.008;
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const ratio = index / Math.max(sampleCount - 1, 1);
    const centerLift = 0.36 + Math.pow(Math.sin(Math.PI * ratio), 1.2) * 0.24;
    const drift = gaussian(ratio, 0.5 + Math.sin(time * 0.1) * 0.08, 0.36);
    const sideDrift = gaussian(ratio, 0.18 + Math.sin(time * 0.08) * 0.03, 0.14) * 0.006;
    return clamp((0.018 + drift * 0.028 + sideDrift) * centerLift, 0.01, 0.07);
  });

  return { samples, energy: clamp(energy, 0.04, 0.09), bass: 0, ambient: clamp(energy, 0.04, 0.09), active: false };
}

function averageFrequencyRange(
  data: Uint8Array,
  sampleRate: number,
  fftSize: number,
  startFrequency: number,
  endFrequency: number,
) {
  const boundedStart = clampInt(frequencyToBin(startFrequency, sampleRate, fftSize), 0, data.length);
  const boundedEnd = clampInt(frequencyToBin(endFrequency, sampleRate, fftSize) + 1, boundedStart + 1, data.length);
  let total = 0;
  for (let index = boundedStart; index < boundedEnd; index += 1) total += data[index];
  return total / Math.max(boundedEnd - boundedStart, 1) / 255;
}

function frequencyToBin(frequency: number, sampleRate: number, fftSize: number) {
  return Math.round((frequency * fftSize) / Math.max(sampleRate, 1));
}

function averageWaveEnvelope(data: Uint8Array, ratio: number, sampleCount: number) {
  const windowSize = Math.max(8, Math.floor(data.length / sampleCount) * 3);
  const center = Math.floor(ratio * (data.length - 1));
  const start = clampInt(center - Math.floor(windowSize / 2), 0, data.length);
  const end = clampInt(start + windowSize, start + 1, data.length);
  let total = 0;
  for (let index = start; index < end; index += 1) total += Math.abs(data[index] - 128);
  return clamp(Math.pow(total / Math.max(end - start, 1) / 128, 0.78) * 1.18, 0, 1);
}

function calculateRms(data: Uint8Array) {
  let total = 0;
  for (const value of data) {
    const centered = (value - 128) / 128;
    total += centered * centered;
  }
  return Math.sqrt(total / Math.max(data.length, 1));
}

function gaussian(value: number, center: number, width: number) {
  const distance = (value - center) / width;
  return Math.exp(-distance * distance);
}
