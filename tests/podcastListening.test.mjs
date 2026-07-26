import assert from "node:assert/strict";
import test from "node:test";

import {
  filterPodcastListeningEpisodes,
  isPodcastEpisodeNew,
  podcastEpisodePlayedPercent,
} from "../.tmp/visualizer-tests/utils/podcastListening.js";

function episode(id, overrides = {}) {
  return {
    id,
    feedId: "feed",
    title: `单集 ${id}`,
    enclosureUrl: `https://example.com/${id}.mp3`,
    downloadState: "none",
    downloadedBytes: 0,
    progressSeconds: 0,
    completed: false,
    saved: false,
    firstSeenAt: 1_000,
    ...overrides,
  };
}

test("podcast listening filters sort copies without mutating the source", () => {
  const source = [
    episode("old", { publishedAt: 2_000 }),
    episode("fallback", { firstSeenAt: 4_000 }),
    episode("new", { publishedAt: 6_000 }),
  ];

  const result = filterPodcastListeningEpisodes(source, "recent");

  assert.notEqual(result, source);
  assert.deepEqual(result.map(({ id }) => id), ["new", "fallback", "old"]);
  assert.deepEqual(source.map(({ id }) => id), ["old", "fallback", "new"]);
});

test("unplayed keeps only untouched episodes and retains recent ordering", () => {
  const source = [
    episode("in-progress", { publishedAt: 7_000, progressSeconds: 1 }),
    episode("completed", { publishedAt: 8_000, completed: true }),
    episode("older-unplayed", { publishedAt: 4_000 }),
    episode("newer-unplayed", { publishedAt: 6_000 }),
  ];

  assert.deepEqual(
    filterPodcastListeningEpisodes(source, "unplayed").map(({ id }) => id),
    ["newer-unplayed", "older-unplayed"],
  );
});

test("download-first requires a completed local download and sorts each group by recency", () => {
  const source = [
    episode("remote-new", { publishedAt: 9_000 }),
    episode("offline-old", {
      publishedAt: 3_000,
      downloadState: "downloaded",
      localPath: "D:\\podcasts\\offline-old.mp3",
    }),
    episode("state-only", {
      publishedAt: 8_000,
      downloadState: "downloaded",
    }),
    episode("offline-new", {
      publishedAt: 5_000,
      downloadState: "downloaded",
      localPath: "D:\\podcasts\\offline-new.mp3",
    }),
  ];

  assert.deepEqual(
    filterPodcastListeningEpisodes(source, "download-first").map(
      ({ id }) => id,
    ),
    ["offline-new", "offline-old", "remote-new", "state-only"],
  );
});

test("new badge requires post-subscription discovery and a release in the past 24 hours", () => {
  const now = 100 * 24 * 60 * 60 * 1000;
  const subscribedAt = now - 3 * 24 * 60 * 60 * 1000;
  const fresh = episode("fresh", {
    firstSeenAt: now - 60_000,
    publishedAt: now - 60 * 60 * 1000,
  });

  assert.equal(isPodcastEpisodeNew(fresh, subscribedAt, now), true);
  assert.equal(
    isPodcastEpisodeNew(
      { ...fresh, firstSeenAt: subscribedAt },
      subscribedAt,
      now,
    ),
    false,
  );
  assert.equal(
    isPodcastEpisodeNew(
      { ...fresh, publishedAt: now - 24 * 60 * 60 * 1000 - 1 },
      subscribedAt,
      now,
    ),
    false,
  );
  assert.equal(
    isPodcastEpisodeNew({ ...fresh, publishedAt: now + 1 }, subscribedAt, now),
    false,
  );
  assert.equal(
    isPodcastEpisodeNew({ ...fresh, completed: true }, subscribedAt, now),
    false,
  );
  assert.equal(isPodcastEpisodeNew(fresh, Number.NaN, now), false);
});

test("new badge falls back to first-seen time when publication time is absent", () => {
  const now = 2_000_000_000_000;
  const subscribedAt = now - 60 * 60 * 1000;
  const fresh = episode("fresh", {
    firstSeenAt: now - 30 * 60 * 1000,
    publishedAt: null,
  });

  assert.equal(isPodcastEpisodeNew(fresh, subscribedAt, now), true);
  assert.equal(
    isPodcastEpisodeNew(
      { ...fresh, firstSeenAt: now + 1 },
      subscribedAt,
      now,
    ),
    false,
  );
});

test("played percentage distinguishes untouched, partial, and completed episodes", () => {
  assert.equal(
    podcastEpisodePlayedPercent({
      completed: false,
      durationSeconds: 100,
      progressSeconds: 0,
    }),
    null,
  );
  assert.equal(
    podcastEpisodePlayedPercent({
      completed: false,
      durationSeconds: null,
      progressSeconds: 20,
    }),
    null,
  );
  assert.equal(
    podcastEpisodePlayedPercent({
      completed: false,
      durationSeconds: 100,
      progressSeconds: 0.1,
    }),
    1,
  );
  assert.equal(
    podcastEpisodePlayedPercent({
      completed: false,
      durationSeconds: 100,
      progressSeconds: 33.6,
    }),
    34,
  );
  assert.equal(
    podcastEpisodePlayedPercent({
      completed: false,
      durationSeconds: 100,
      progressSeconds: 100,
    }),
    99,
  );
  assert.equal(
    podcastEpisodePlayedPercent({
      completed: true,
      durationSeconds: null,
      progressSeconds: 0,
    }),
    100,
  );
});
