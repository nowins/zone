import assert from "node:assert/strict";
import test from "node:test";
import {
  createPodcastProgressWriteGate,
} from "../.tmp/visualizer-tests/utils/podcastProgress.js";

test("explicit played-state changes invalidate queued progress and suppress automatic saves", () => {
  const gate = createPodcastProgressWriteGate();
  const queuedEpoch = gate.capture("episode-a");

  gate.suppress("episode-a");

  assert.equal(gate.allows("episode-a", queuedEpoch), false);
  assert.equal(gate.isSuppressed("episode-a"), true);
  assert.equal(gate.allows("episode-b", gate.capture("episode-b")), true);
});

test("a later explicit resume creates a fresh progress-writing session", () => {
  const gate = createPodcastProgressWriteGate();
  gate.suppress("episode-a");
  const suppressedEpoch = gate.capture("episode-a");

  assert.equal(gate.resume("episode-b"), false);
  assert.equal(gate.resume("episode-a"), true);
  assert.equal(gate.allows("episode-a", suppressedEpoch), false);

  const resumedEpoch = gate.capture("episode-a");
  assert.equal(gate.isSuppressed("episode-a"), false);
  assert.equal(gate.allows("episode-a", resumedEpoch), true);
});
