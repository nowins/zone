export type BeatSource = "idle" | "realtime" | "offline";

export type BeatPeak = {
  time: number;
  strength: number;
};

export type BeatGrid = {
  bpm: number;
  interval: number;
  firstBeatTime: number;
  confidence: number;
  source: Exclude<BeatSource, "idle">;
};

export type BeatFrame = {
  beatPulse: number;
  beatPhase: number;
  onsetStrength: number;
  bpm: number;
  confidence: number;
  nextBeatTime: number;
  source: BeatSource;
};

const DEFAULT_SAMPLE_RATE = 44_100;
const MIN_BPM = 60;
const MAX_BPM = 200;
const MIN_INTERVAL = 60 / MAX_BPM;
const MAX_INTERVAL = 60 / MIN_BPM;
const REALTIME_HISTORY_LIMIT = 96;
const PEAK_HISTORY_SECONDS = 18;
const REALTIME_BAND_COUNT = 36;

export function createIdleBeatFrame(): BeatFrame {
  return {
    beatPulse: 0,
    beatPhase: 0,
    onsetStrength: 0,
    bpm: 0,
    confidence: 0,
    nextBeatTime: 0,
    source: "idle",
  };
}

export class RealtimeBeatAnalyzer {
  private previousBands: number[] | null = null;
  private fluxHistory: number[] = [];
  private peaks: BeatPeak[] = [];
  private lastOnsetTime = -Infinity;
  private realtimeGrid: BeatGrid | null = null;

  update(
    frequencyData: Uint8Array,
    timeData: Uint8Array,
    currentTime: number,
    sampleRate = DEFAULT_SAMPLE_RATE,
    fftSize = Math.max(timeData.length, frequencyData.length * 2),
    offlineGrid: BeatGrid | null = null,
  ): BeatFrame {
    const bands = createLogBands(frequencyData, sampleRate, fftSize, REALTIME_BAND_COUNT);
    const rms = calculateRms(timeData);
    const flux = this.previousBands
      ? bands.reduce((total, value, index) => total + Math.max(0, value - (this.previousBands?.[index] ?? 0)), 0) / bands.length
      : 0;
    this.previousBands = bands;

    this.fluxHistory.push(flux);
    if (this.fluxHistory.length > REALTIME_HISTORY_LIMIT) this.fluxHistory.shift();

    const stats = statsFor(this.fluxHistory);
    const threshold = stats.mean + stats.std * 1.15 + 0.006;
    const onsetStrength = clamp((flux - threshold) / Math.max(0.028, stats.std + rms * 0.16), 0, 1);
    const isOnset = onsetStrength > 0.18 && currentTime - this.lastOnsetTime > 0.115;

    if (isOnset) {
      this.peaks.push({ time: currentTime, strength: onsetStrength });
      this.lastOnsetTime = currentTime;
      this.peaks = this.peaks.filter((peak) => currentTime - peak.time <= PEAK_HISTORY_SECONDS);
      const grid = estimateBeatGrid(this.peaks, "realtime");
      if (grid && (!this.realtimeGrid || grid.confidence >= this.realtimeGrid.confidence * 0.82)) {
        this.realtimeGrid = grid;
      }
    }

    const selectedGrid =
      offlineGrid && offlineGrid.confidence >= Math.max(0.36, this.realtimeGrid?.confidence ?? 0)
        ? offlineGrid
        : this.realtimeGrid;
    return createBeatFrameFromGrid(selectedGrid, currentTime, onsetStrength);
  }
}

export function analyzePcmBeatGrid(channelData: Float32Array, sampleRate = DEFAULT_SAMPLE_RATE): BeatGrid | null {
  if (channelData.length < sampleRate * 1.5) return null;

  const frameSize = 2048;
  const hopSize = 512;
  const bandCount = 32;
  const window = createHannWindow(frameSize);
  const real = new Float32Array(frameSize);
  const imag = new Float32Array(frameSize);
  let previousBands: number[] | null = null;
  const novelty: number[] = [];
  const frameTimes: number[] = [];

  for (let offset = 0; offset + frameSize < channelData.length; offset += hopSize) {
    for (let index = 0; index < frameSize; index += 1) {
      real[index] = channelData[offset + index] * window[index];
      imag[index] = 0;
    }
    fft(real, imag);

    const bands = createLogBandsFromSpectrum(real, imag, sampleRate, frameSize, bandCount);
    const spectralFlux = previousBands
      ? bands.reduce((total, value, index) => total + Math.max(0, value - (previousBands?.[index] ?? 0)), 0) / bands.length
      : 0;
    previousBands = bands;
    novelty.push(spectralFlux);
    frameTimes.push(offset / sampleRate);
  }

  const peaks = pickNoveltyPeaks(novelty, frameTimes);
  return estimateBeatGrid(peaks, "offline");
}

export function estimateBeatGrid(peaks: BeatPeak[], source: Exclude<BeatSource, "idle">): BeatGrid | null {
  const usefulPeaks = peaks.filter((peak) => peak.strength > 0.08).slice(-64);
  if (usefulPeaks.length < 4) return null;

  const bins = new Map<number, number>();
  let totalWeight = 0;

  for (let left = 0; left < usefulPeaks.length; left += 1) {
    for (let right = left + 1; right < usefulPeaks.length; right += 1) {
      const rawInterval = usefulPeaks[right].time - usefulPeaks[left].time;
      if (rawInterval < 0.18 || rawInterval > 2.2) continue;

      const interval = normalizeBeatInterval(rawInterval);
      if (interval < MIN_INTERVAL || interval > MAX_INTERVAL) continue;
      const bpm = Math.round(60 / interval);
      const weight = Math.sqrt(usefulPeaks[left].strength * usefulPeaks[right].strength) / (1 + (right - left) * 0.12);
      bins.set(bpm, (bins.get(bpm) ?? 0) + weight);
      totalWeight += weight;
    }
  }

  if (bins.size === 0 || totalWeight === 0) return null;

  let bestBpm = 0;
  let bestWeight = 0;
  for (const [bpm, weight] of bins) {
    const neighborWeight = weightedBin(bins, bpm);
    if (neighborWeight > bestWeight) {
      bestWeight = neighborWeight;
      bestBpm = bpm;
    }
  }

  if (bestBpm < 90 && bestBpm * 2 <= MAX_BPM) {
    const doubleWeight = weightedBin(bins, bestBpm * 2);
    if (doubleWeight >= bestWeight * 0.38) {
      bestBpm *= 2;
      bestWeight = doubleWeight;
    }
  } else if (bestBpm > 160 && bestBpm / 2 >= MIN_BPM) {
    const halfWeight = weightedBin(bins, Math.round(bestBpm / 2));
    if (halfWeight >= bestWeight * 0.62) {
      bestBpm = Math.round(bestBpm / 2);
      bestWeight = halfWeight;
    }
  }

  const interval = 60 / bestBpm;
  const firstBeatTime = chooseBestPhase(usefulPeaks, interval);
  const regularity = bestWeight / Math.max(totalWeight, 1);
  const support = Math.min(1, usefulPeaks.length / 14);
  const confidence = clamp(regularity * 1.55 * support, 0, source === "offline" ? 0.96 : 0.82);
  if (confidence < 0.12) return null;

  return {
    bpm: bestBpm,
    interval,
    firstBeatTime,
    confidence,
    source,
  };
}

function createBeatFrameFromGrid(grid: BeatGrid | null, currentTime: number, onsetStrength: number): BeatFrame {
  if (!grid) {
    return {
      beatPulse: onsetStrength,
      beatPhase: 0,
      onsetStrength,
      bpm: 0,
      confidence: 0,
      nextBeatTime: 0,
      source: onsetStrength > 0 ? "realtime" : "idle",
    };
  }

  const phase = positiveModulo((currentTime - grid.firstBeatTime) / grid.interval, 1);
  const beatPulse = clamp(Math.exp(-phase * 9.5) * grid.confidence + onsetStrength * 0.82, 0, 1);
  return {
    beatPulse,
    beatPhase: phase,
    onsetStrength,
    bpm: grid.bpm,
    confidence: grid.confidence,
    nextBeatTime: currentTime + (1 - phase) * grid.interval,
    source: grid.source,
  };
}

function pickNoveltyPeaks(novelty: number[], frameTimes: number[]) {
  const peaks: BeatPeak[] = [];
  const refractoryFrames = 5;
  let lastPeakIndex = -Infinity;

  for (let index = 4; index < novelty.length - 4; index += 1) {
    const start = Math.max(0, index - 32);
    const end = Math.min(novelty.length, index + 33);
    const local = novelty.slice(start, end);
    const stats = statsFor(local);
    const value = novelty[index];
    const isLocalMax =
      value > novelty[index - 1] &&
      value >= novelty[index + 1] &&
      value > stats.mean + stats.std * 0.9 + 0.002;
    if (!isLocalMax || index - lastPeakIndex < refractoryFrames) continue;
    peaks.push({
      time: frameTimes[index],
      strength: clamp((value - stats.mean) / Math.max(0.01, stats.std * 3.2), 0.05, 1),
    });
    lastPeakIndex = index;
  }

  return peaks;
}

function createLogBands(data: Uint8Array, sampleRate: number, fftSize: number, bandCount: number) {
  return Array.from({ length: bandCount }, (_, index) => {
    const startFrequency = logFrequency(index / bandCount);
    const endFrequency = logFrequency((index + 1) / bandCount);
    const start = clampInt(frequencyToBin(startFrequency, sampleRate, fftSize), 0, data.length);
    const end = clampInt(frequencyToBin(endFrequency, sampleRate, fftSize) + 1, start + 1, data.length);
    let total = 0;
    for (let bin = start; bin < end; bin += 1) total += data[bin] / 255;
    return Math.sqrt(total / Math.max(1, end - start));
  });
}

function createLogBandsFromSpectrum(
  real: Float32Array,
  imag: Float32Array,
  sampleRate: number,
  fftSize: number,
  bandCount: number,
) {
  const half = fftSize / 2;
  return Array.from({ length: bandCount }, (_, index) => {
    const startFrequency = logFrequency(index / bandCount);
    const endFrequency = logFrequency((index + 1) / bandCount);
    const start = clampInt(frequencyToBin(startFrequency, sampleRate, fftSize), 1, half);
    const end = clampInt(frequencyToBin(endFrequency, sampleRate, fftSize) + 1, start + 1, half);
    let total = 0;
    for (let bin = start; bin < end; bin += 1) total += Math.hypot(real[bin], imag[bin]);
    return Math.log1p(total / Math.max(1, end - start));
  });
}

function normalizeBeatInterval(interval: number) {
  let normalized = interval;
  while (normalized < MIN_INTERVAL) normalized *= 2;
  while (normalized > MAX_INTERVAL) normalized /= 2;
  return normalized;
}

function chooseBestPhase(peaks: BeatPeak[], interval: number) {
  let bestPeak = peaks[0];
  let bestScore = -Infinity;
  for (const candidate of peaks) {
    let score = 0;
    for (const peak of peaks) {
      const phase = positiveModulo((peak.time - candidate.time) / interval, 1);
      const distance = Math.min(phase, 1 - phase);
      score += peak.strength * Math.exp(-distance * distance * 96);
    }
    if (score > bestScore) {
      bestScore = score;
      bestPeak = candidate;
    }
  }
  return bestPeak.time;
}

function weightedBin(bins: Map<number, number>, bpm: number) {
  return (bins.get(bpm) ?? 0) + (bins.get(bpm - 1) ?? 0) * 0.45 + (bins.get(bpm + 1) ?? 0) * 0.45;
}

function fft(real: Float32Array, imag: Float32Array) {
  const length = real.length;
  let j = 0;
  for (let i = 1; i < length; i += 1) {
    let bit = length >> 1;
    while ((j & bit) !== 0) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = real[i];
      const ti = imag[i];
      real[i] = real[j];
      imag[i] = imag[j];
      real[j] = tr;
      imag[j] = ti;
    }
  }

  for (let size = 2; size <= length; size <<= 1) {
    const half = size >> 1;
    const angle = (-2 * Math.PI) / size;
    const stepR = Math.cos(angle);
    const stepI = Math.sin(angle);
    for (let offset = 0; offset < length; offset += size) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < half; k += 1) {
        const even = offset + k;
        const odd = even + half;
        const tr = wr * real[odd] - wi * imag[odd];
        const ti = wr * imag[odd] + wi * real[odd];
        real[odd] = real[even] - tr;
        imag[odd] = imag[even] - ti;
        real[even] += tr;
        imag[even] += ti;
        const nextWr = wr * stepR - wi * stepI;
        wi = wr * stepI + wi * stepR;
        wr = nextWr;
      }
    }
  }
}

function createHannWindow(size: number) {
  return Float32Array.from({ length: size }, (_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / Math.max(1, size - 1)));
}

function logFrequency(ratio: number) {
  const min = Math.log2(38);
  const max = Math.log2(9_200);
  return 2 ** (min + (max - min) * ratio);
}

function frequencyToBin(frequency: number, sampleRate: number, fftSize: number) {
  return Math.round((frequency * fftSize) / Math.max(sampleRate, 1));
}

function calculateRms(data: Uint8Array) {
  let total = 0;
  for (const value of data) {
    const centered = (value - 128) / 128;
    total += centered * centered;
  }
  return Math.sqrt(total / Math.max(1, data.length));
}

function statsFor(values: number[]) {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function clampInt(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
