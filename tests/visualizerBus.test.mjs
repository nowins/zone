import assert from "node:assert/strict";
import test from "node:test";
import { VISUALIZER_SAMPLE_COUNT } from "../.tmp/visualizer-tests/constants.js";
import {
  getVisualizerFrame,
  publishVisualizerFrame,
} from "../.tmp/visualizer-tests/utils/visualizerBus.js";

test("initial bus frame is silent until real media samples arrive", () => {
  const frame = getVisualizerFrame();
  assert.equal(frame.samples.length, VISUALIZER_SAMPLE_COUNT);
  assert.ok(frame.samples.every((sample) => sample === 0));
  assert.ok(frame.transients.every((sample) => sample === 0));
  assert.equal(frame.energy, 0);
  assert.equal(frame.beatPulse, 0);
  assert.equal(frame.beatPhase, 0);
  assert.equal(frame.onsetStrength, 0);
  assert.equal(frame.beatConfidence, 0);
});

test("get returns the same reference that was published", () => {
  const published = {
    samples: [0.1, 0.2, 0.3],
    energy: 0.42,
    beatPulse: 0.7,
    beatPhase: 0.25,
    onsetStrength: 0.5,
    beatConfidence: 0.9,
  };
  publishVisualizerFrame(published);
  assert.equal(getVisualizerFrame(), published);
});

test("a later publish replaces the stored frame", () => {
  const first = {
    samples: [0.4],
    energy: 0.2,
    beatPulse: 0.1,
    beatPhase: 0.6,
    onsetStrength: 0.05,
    beatConfidence: 0.3,
  };
  const second = {
    samples: [0.9],
    energy: 0.8,
    beatPulse: 0.95,
    beatPhase: 0.02,
    onsetStrength: 0.88,
    beatConfidence: 0.77,
  };
  publishVisualizerFrame(first);
  publishVisualizerFrame(second);
  assert.equal(getVisualizerFrame(), second);
});
