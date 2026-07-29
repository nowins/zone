import assert from "node:assert/strict";
import test from "node:test";
import {
  isCurrentPlayAttempt,
  podcastStatusForCanPlay,
  podcastStatusForPause,
  podcastStatusForWaiting,
  resolvePodcastResumePosition,
  resolvePodcastStartPosition,
  shouldConsumePendingQueueEpisode,
} from "../.tmp/visualizer-tests/utils/playbackTransport.js";

test("isCurrentPlayAttempt matches attempt and source together", () => {
  const token = { sourceKey: "music\0a", attempt: 3 };
  assert.equal(isCurrentPlayAttempt(token, 3, "music\0a"), true);
  assert.equal(isCurrentPlayAttempt(token, 4, "music\0a"), false);
  assert.equal(isCurrentPlayAttempt(token, 3, "music\0b"), false);
  const nullSource = { sourceKey: null, attempt: 1 };
  assert.equal(isCurrentPlayAttempt(nullSource, 1, null), true);
});

test("resolvePodcastStartPosition prefers an explicit start for the same episode", () => {
  assert.deepEqual(
    resolvePodcastStartPosition(null, "ep-1", 42),
    { position: 42, explicit: false },
  );
  assert.deepEqual(
    resolvePodcastStartPosition({ episodeId: "ep-1", position: 120 }, "ep-1", 42),
    { position: 120, explicit: true },
  );
  assert.deepEqual(
    resolvePodcastStartPosition({ episodeId: "ep-2", position: 120 }, "ep-1", 42),
    { position: 42, explicit: false },
  );
});

test("resolvePodcastResumePosition honors explicit positions without metadata", () => {
  assert.equal(
    resolvePodcastResumePosition(
      { position: 600, explicit: true },
      { completed: false },
      0,
    ),
    600,
  );
  assert.equal(
    resolvePodcastResumePosition(
      { position: 600, explicit: true },
      { completed: false },
      300,
    ),
    300,
  );
});

test("resolvePodcastResumePosition restarts finished or nearly finished episodes", () => {
  assert.equal(
    resolvePodcastResumePosition({ position: 100 }, { completed: true }, 1000),
    0,
  );
  assert.equal(
    resolvePodcastResumePosition({ position: 996 }, { completed: false }, 1000),
    0,
  );
});

test("resolvePodcastResumePosition resumes from saved progress", () => {
  assert.equal(
    resolvePodcastResumePosition({ position: 100 }, { completed: false }, 1000),
    100,
  );
  assert.equal(
    resolvePodcastResumePosition({ position: 100 }, { completed: false }, 0),
    100,
  );
  assert.equal(
    resolvePodcastResumePosition({ position: 0 }, { completed: false }, 1000),
    0,
  );
});

test("shouldConsumePendingQueueEpisode requires all three guards to match", () => {
  assert.equal(shouldConsumePendingQueueEpisode(null, "ep-1", "ep-1", "ep-1"), false);
  assert.equal(shouldConsumePendingQueueEpisode("ep-2", "ep-1", "ep-1", "ep-1"), false);
  assert.equal(shouldConsumePendingQueueEpisode("ep-1", "ep-2", "ep-1", "ep-1"), false);
  assert.equal(shouldConsumePendingQueueEpisode("ep-1", "ep-1", "ep-2", "ep-1"), false);
  assert.equal(shouldConsumePendingQueueEpisode("ep-1", "ep-1", "ep-1", "ep-1"), true);
});

test("podcast status helpers cover intent and pause combinations", () => {
  assert.equal(podcastStatusForPause(true), "loading");
  assert.equal(podcastStatusForPause(false), "paused");
  assert.equal(podcastStatusForWaiting(true), "buffering");
  assert.equal(podcastStatusForWaiting(false), "paused");
  assert.equal(podcastStatusForCanPlay(false, true), "paused");
  assert.equal(podcastStatusForCanPlay(false, false), "paused");
  assert.equal(podcastStatusForCanPlay(true, true), "loading");
  assert.equal(podcastStatusForCanPlay(true, false), "playing");
});
