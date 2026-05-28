import assert from "node:assert/strict";
import test from "node:test";
import {
  createAudioVisualizerFrame,
  createIdleVisualizerFrame,
} from "../.tmp/visualizer-tests/utils/visualizer.js";

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
