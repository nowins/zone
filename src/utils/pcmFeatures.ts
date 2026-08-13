import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track } from "../types";

export type PcmFeatureSummary = {
  rms?: number;
  peak?: number;
  zeroCrossingRate?: number;
  spectralCentroid?: number;
  tempoBpm?: number;
};

function mixToMono(buffer: AudioBuffer) {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  if (channels <= 1) return buffer.getChannelData(0).slice(0, Math.min(length, buffer.sampleRate * 45));
  const limit = Math.min(length, buffer.sampleRate * 45);
  const mixed = new Float32Array(limit);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < limit; index += 1) mixed[index] += data[index] / channels;
  }
  return mixed;
}

export async function extractPcmFeatureSummary(track: Track): Promise<PcmFeatureSummary | null> {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    const context = new AudioContextClass();
    const response = await fetch(convertFileSrc(track.path, "zone-audio"));
    const raw = await response.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(raw.slice(0));
    const mono = mixToMono(audioBuffer);
    await context.close().catch(() => undefined);

    let sumSquares = 0;
    let peak = 0;
    let zeroCrossings = 0;
    let weighted = 0;
    let magnitudeSum = 0;
    for (let index = 0; index < mono.length; index += 1) {
      const sample = mono[index] ?? 0;
      const abs = Math.abs(sample);
      sumSquares += sample * sample;
      if (abs > peak) peak = abs;
      if (index > 0) {
        const prev = mono[index - 1] ?? 0;
        if ((sample >= 0 && prev < 0) || (sample < 0 && prev >= 0)) zeroCrossings += 1;
      }
      // crude spectral proxy using local difference energy
      const delta = index > 0 ? Math.abs(sample - (mono[index - 1] ?? 0)) : 0;
      weighted += delta * (index / mono.length);
      magnitudeSum += delta;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, mono.length));
    const zcr = zeroCrossings / Math.max(1, mono.length);
    const centroid = magnitudeSum > 1e-9 ? weighted / magnitudeSum : 0.5;

    // Very light tempo estimate from envelope autocorrelation over 2..0.3s.
    const sampleRate = audioBuffer.sampleRate;
    const step = Math.max(1, Math.floor(sampleRate / 200));
    const envelope: number[] = [];
    for (let index = 0; index < mono.length; index += step) {
      let acc = 0;
      const end = Math.min(mono.length, index + step);
      for (let cursor = index; cursor < end; cursor += 1) acc += Math.abs(mono[cursor] ?? 0);
      envelope.push(acc / (end - index));
    }
    const minLag = Math.floor((60 / 200) * (sampleRate / step));
    const maxLag = Math.floor((60 / 60) * (sampleRate / step));
    let bestLag = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let score = 0;
      for (let index = 0; index + lag < envelope.length; index += 1) {
        score += (envelope[index] ?? 0) * (envelope[index + lag] ?? 0);
      }
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }
    const tempoBpm = bestLag > 0 ? (60 * (sampleRate / step)) / bestLag : undefined;

    return {
      rms: Math.max(0, Math.min(1, rms * 2.4)),
      peak: Math.max(0, Math.min(1, peak)),
      zeroCrossingRate: Math.max(0, Math.min(1, zcr * 8)),
      spectralCentroid: Math.max(0, Math.min(1, centroid)),
      tempoBpm,
    };
  } catch {
    return null;
  }
}
