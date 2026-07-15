import assert from "node:assert/strict";
import test from "node:test";
import {
  RealtimeBeatAnalyzer,
  analyzePcmBeatGrid,
  createIdleBeatFrame,
  estimateBeatGrid,
} from "../.tmp/visualizer-tests/utils/beatAnalysis.js";
import { createZuneGlowFrame } from "../.tmp/visualizer-tests/utils/audioGlow.js";

const SAMPLE_RATE = 44_100;
const FFT_SIZE = 2048;

test("realtime analyzer detects synthetic onset peaks", () => {
  const analyzer = new RealtimeBeatAnalyzer();
  const frames = [];
  for (let index = 0; index < 80; index += 1) {
    const time = index * 0.05;
    const isHit = index === 12 || index === 22 || index === 32 || index === 42;
    frames.push(analyzer.update(createSpectrum(isHit ? 235 : 18), createWaveform(isHit ? 78 : 2), time, SAMPLE_RATE, FFT_SIZE));
  }

  assert.ok(frames.some((frame) => frame.onsetStrength > 0.35), "expected at least one strong realtime onset");
  assert.ok(frames.some((frame) => frame.beatPulse > 0.35), "onsets should feed beat pulse");
});

test("regular 120 BPM peaks estimate close to 120 BPM", () => {
  const peaks = makePeaks(0, 0.5, 18);
  const grid = estimateBeatGrid(peaks, "offline");

  assert.ok(grid, "expected beat grid");
  assert.ok(Math.abs(grid.bpm - 120) <= 2, `expected about 120 BPM, got ${grid?.bpm}`);
  assert.ok(grid.confidence > 0.45, `expected useful confidence, got ${grid.confidence}`);
});

test("double tempo peak train normalizes into target BPM range", () => {
  const peaks = makePeaks(0, 0.25, 28);
  const grid = estimateBeatGrid(peaks, "offline");

  assert.ok(grid, "expected beat grid");
  assert.ok(grid.bpm >= 118 && grid.bpm <= 122, `expected 240 BPM clicks to normalize near 120, got ${grid.bpm}`);
});

test("offline PCM analysis estimates click-track tempo", () => {
  const pcm = createClickTrack(8, 0.5);
  const grid = analyzePcmBeatGrid(pcm, SAMPLE_RATE);

  assert.ok(grid, "expected offline grid from click track");
  assert.ok(Math.abs(grid.bpm - 120) <= 3, `expected about 120 BPM, got ${grid?.bpm}`);
  assert.ok(grid.confidence > 0.35, `expected usable offline confidence, got ${grid.confidence}`);
});

test("silence does not create a confident beat grid", () => {
  const grid = analyzePcmBeatGrid(new Float32Array(SAMPLE_RATE * 6), SAMPLE_RATE);
  const idle = createIdleBeatFrame();

  assert.equal(grid, null);
  assert.equal(idle.beatPulse, 0);
  assert.equal(idle.confidence, 0);
});

test("beat and onset drive a centered Zune glow attack", () => {
  const calm = createZuneGlowFrame({ energy: 0.05, beatPulse: 0, onsetStrength: 0, beatPhase: 0.5, time: 1 });
  const hit = createZuneGlowFrame({ energy: 0.2, beatPulse: 0.9, onsetStrength: 0.8, beatPhase: 0.04, time: 1 });

  assert.ok(hit.centerIntensity > hit.edgeIntensity * 7, "glow should concentrate at center");
  assert.ok(hit.centerIntensity > calm.centerIntensity * 2, "beat/onset should create a clear glow attack");
  assert.ok(hit.bodyWidth > calm.bodyWidth, "beat/onset should expand the central glow body");
});

function makePeaks(start, interval, count) {
  return Array.from({ length: count }, (_, index) => ({ time: start + index * interval, strength: 0.8 }));
}

function createSpectrum(value) {
  const data = new Uint8Array(FFT_SIZE / 2);
  for (let index = 2; index < 160; index += 1) data[index] = value;
  for (let index = 180; index < 380; index += 1) data[index] = Math.round(value * 0.55);
  return data;
}

function createWaveform(amplitude) {
  return Uint8Array.from({ length: FFT_SIZE }, (_, index) => {
    const wave = Math.sin(index / 7) * 0.7 + Math.sin(index / 17) * 0.3;
    return Math.round(128 + wave * amplitude);
  });
}

function createClickTrack(seconds, interval) {
  const length = Math.floor(seconds * SAMPLE_RATE);
  const data = new Float32Array(length);
  for (let time = 0; time < seconds; time += interval) {
    const start = Math.floor(time * SAMPLE_RATE);
    for (let index = 0; index < 420 && start + index < data.length; index += 1) {
      data[start + index] += Math.sin(index * 0.44) * Math.exp(-index / 90);
    }
  }
  return data;
}
