import assert from "node:assert/strict";
import test from "node:test";
import {
  createAudioVisualizerFrame,
  createIdleVisualizerFrame,
  createSilentVisualizerFrame,
  AudioVisualizerAnalyzer,
} from "../.tmp/visualizer-tests/utils/visualizer.js";
import { createZuneMountainFrame } from "../.tmp/visualizer-tests/utils/audioGlow.js";

const SAMPLE_COUNT = 180;
const SAMPLE_RATE = 44_100;
const FFT_SIZE = 2048;

test("idle visualizer stays low and inactive", () => {
  const frame = createIdleVisualizerFrame(SAMPLE_COUNT, 18, 42);
  const maximum = Math.max(...frame.samples);

  assert.equal(frame.samples.length, SAMPLE_COUNT);
  assert.equal(frame.active, false);
  assert.ok(frame.energy <= 0.09, `idle energy should stay subtle, got ${frame.energy}`);
  assert.ok(maximum <= 0.07, `idle samples should not create a visible plume, got ${maximum}`);
});

test("low frequency content creates a broad restrained horizon", () => {
  const frequencyData = new Uint8Array(FFT_SIZE / 2);
  fillFrequencyRange(frequencyData, 45, 135, 230);
  fillFrequencyRange(frequencyData, 150, 360, 120);

  const frame = createAudioVisualizerFrame(
    frequencyData,
    createWaveform(58),
    SAMPLE_COUNT,
    SAMPLE_RATE,
    FFT_SIZE,
  );
  const maximum = Math.max(...frame.samples);
  const center = frame.samples[Math.floor(frame.samples.length / 2)];
  const edge = Math.max(frame.samples[0], frame.samples.at(-1) ?? 0);
  const maxDelta = maxAdjacentDelta(frame.samples);

  assert.equal(frame.samples.length, SAMPLE_COUNT);
  assert.equal(frame.active, true);
  assert.ok(maximum >= 0.08, `active low-frequency content should stay visible, got ${maximum}`);
  assert.ok(maximum <= 0.38, `horizon should remain restrained, got ${maximum}`);
  assert.ok(center > edge * 1.8, `center should carry the low-frequency body, center ${center}, edge ${edge}`);
  assert.ok(maxDelta < 0.045, `horizon should be smooth, max adjacent delta ${maxDelta}`);
});

test("high frequency texture alone does not become an equalizer", () => {
  const frequencyData = new Uint8Array(FFT_SIZE / 2);
  fillFrequencyRange(frequencyData, 2600, 5600, 255);

  const frame = createAudioVisualizerFrame(
    frequencyData,
    createWaveform(0),
    SAMPLE_COUNT,
    SAMPLE_RATE,
    FFT_SIZE,
  );
  const maximum = Math.max(...frame.samples);

  assert.equal(frame.active, false);
  assert.ok(maximum < 0.055, `high-frequency-only content should stay nearly flat, got ${maximum}`);
});

function fillFrequencyRange(data, startFrequency, endFrequency, value) {
  const start = frequencyToBin(startFrequency);
  const end = Math.min(data.length - 1, frequencyToBin(endFrequency));
  for (let index = start; index <= end; index += 1) {
    data[index] = value;
  }
}

function tonalFrame(start, end, level = 230) {
  const frequencies = new Uint8Array(FFT_SIZE / 2);
  fillFrequencyRange(frequencies, start, end, level);
  return createAudioVisualizerFrame(frequencies, createWaveform(58), SAMPLE_COUNT, SAMPLE_RATE, FFT_SIZE);
}

test("equal PCM loudness with different frequency content moves the body and changes its contour", () => {
  const bass = tonalFrame(45, 135);
  const voice = tonalFrame(230, 500);
  const mountain = (frame) => createZuneMountainFrame({
    ...frame, energy: 0.4, beatPulse: 0, onsetStrength: 0, beatPhase: 1, time: 0,
  });
  const low = mountain(bass), mid = mountain(voice);
  assert.ok(Math.abs(low.bodyCenterX - mid.bodyCenterX) > 0.06);
  const normalize = (points) => points.map(p => p.height / Math.max(...points.map(p => p.height)));
  const a = normalize(low.ridgePoints), b = normalize(mid.ridgePoints);
  const difference = a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
  assert.ok(difference > 0.2, `contour must change, not just its overall height: ${difference}`);
});

test("a fresh drum attack has local crests which settle on a sustained sound", () => {
  const analyzer = new AudioVisualizerAnalyzer();
  analyzer.update(createSilentVisualizerFrame(SAMPLE_COUNT), 0);
  let frame = analyzer.update(tonalFrame(45, 135), 1 / 60);
  const attack = Math.max(...frame.transients);
  assert.ok(attack > 0.2);
  assert.ok(frame.onsetStrength > 0.5);
  for (let i = 2; i < 100; i++) frame = analyzer.update(tonalFrame(45, 135), i / 60);
  assert.ok(Math.max(...frame.transients) < attack * 0.01);
  assert.ok(frame.onsetStrength < 0.01);
  assert.ok(Math.max(...frame.samples) > 0.1, "sustained bass keeps body without invented beats");
});

test("seeking and restart discard previous section attacks", () => {
  const analyzer = new AudioVisualizerAnalyzer();
  analyzer.update(createSilentVisualizerFrame(SAMPLE_COUNT), 0);
  analyzer.update(tonalFrame(45, 135), 1 / 60);
  for (const time of [90, 10]) {
    const frame = analyzer.update(tonalFrame(230, 500), time);
    assert.equal(frame.onsetStrength, 0);
    assert.ok(frame.transients.every(value => value === 0));
  }
});

test("silence never falls back to an animated signal, even with stale FFT energy", () => {
  const frequencyData = new Uint8Array(FFT_SIZE / 2).fill(230);
  const silent = createAudioVisualizerFrame(frequencyData, new Uint8Array(FFT_SIZE).fill(128), SAMPLE_COUNT);
  assert.equal(silent.energy, 0);
  assert.equal(silent.active, false);
  assert.ok(silent.samples.every(value => value === 0));
  const analyzer = new AudioVisualizerAnalyzer();
  analyzer.update(tonalFrame(45, 135), 0);
  let frame;
  for (let i = 1; i <= 180; i++) frame = analyzer.update(silent, i / 60);
  assert.equal(frame.energy, 0);
  assert.equal(frame.onsetStrength, 0);
  assert.ok(Math.max(...frame.samples) < 0.00001);
});

test("a sustained spectrum is independent of wall-clock animation time", () => {
  const input = { ...tonalFrame(45, 135), beatPulse: 0, onsetStrength: 0, beatPhase: 1 };
  assert.deepEqual(createZuneMountainFrame({ ...input, time: 0 }), createZuneMountainFrame({ ...input, time: 50 }));
});

function frequencyToBin(frequency) {
  return Math.round((frequency * FFT_SIZE) / SAMPLE_RATE);
}

function createWaveform(amplitude) {
  return Uint8Array.from({ length: FFT_SIZE }, (_, index) => {
    const wave = Math.sin(index / 9) * 0.7 + Math.sin(index / 23) * 0.3;
    return Math.round(128 + wave * amplitude);
  });
}

function maxAdjacentDelta(samples) {
  let maximum = 0;
  for (let index = 1; index < samples.length; index += 1) {
    maximum = Math.max(maximum, Math.abs(samples[index] - samples[index - 1]));
  }
  return maximum;
}
