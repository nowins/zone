import assert from "node:assert/strict";
import test from "node:test";

import {
  mergePodcastEpisodePlayback,
  movePodcastQueueItem,
  podcastPlaybackForEpisode,
} from "../.tmp/visualizer-tests/utils/podcastPlayback.js";

function episode(id, overrides = {}) {
  return {
    id,
    feedId: "feed",
    title: `单集 ${id}`,
    enclosureUrl: `https://example.com/${id}.mp3`,
    downloadState: "none",
    downloadedBytes: 0,
    progressSeconds: 12,
    completed: false,
    saved: false,
    feedTitle: "示例播客",
    ...overrides,
  };
}

test("podcast playback keeps media metadata and chooses the current source once", () => {
  const source = episode("one", {
    localPath: "D:\\podcasts\\one.mp3",
    feedArtworkUrl: "https://example.com/cover.jpg",
    progressSeconds: -2,
  });
  const playback = podcastPlaybackForEpisode(source);

  assert.equal(playback.episodeId, "one");
  assert.equal(playback.podcastTitle, "示例播客");
  assert.equal(playback.artworkUrl, "https://example.com/cover.jpg");
  assert.equal(playback.savedProgressSeconds, 0);
  assert.equal(playback.playbackLocalPath, "D:\\podcasts\\one.mp3");
});

test("live playback overlays only the active episode without mutating list snapshots", () => {
  const activeSnapshot = episode("one", {
    durationSeconds: 120,
    progressSeconds: 12,
    saved: false,
  });
  const inactiveSnapshot = episode("two", {
    durationSeconds: 180,
    progressSeconds: 12,
  });
  const activePlayback = podcastPlaybackForEpisode({
    ...activeSnapshot,
    completed: true,
    saved: true,
  });

  const active = mergePodcastEpisodePlayback(
    activeSnapshot,
    activePlayback,
    73,
    150,
  );
  const inactive = mergePodcastEpisodePlayback(
    inactiveSnapshot,
    activePlayback,
    73,
    150,
  );

  assert.notEqual(active, activeSnapshot);
  assert.equal(active.progressSeconds, 73);
  assert.equal(active.durationSeconds, 150);
  assert.equal(active.completed, true);
  assert.equal(active.saved, true);
  assert.equal(inactive, inactiveSnapshot);
  assert.equal(inactive.progressSeconds, 12);
  assert.equal(activeSnapshot.progressSeconds, 12);
});

test("podcast queue movement is bounded, immutable, and reindexes positions", () => {
  const queue = ["one", "two", "three"].map((id, position) => ({
    episode: episode(id),
    position,
    addedAt: position + 10,
  }));

  const moved = movePodcastQueueItem(queue, "two", -1);
  assert.deepEqual(moved.map((item) => item.episode.id), ["two", "one", "three"]);
  assert.deepEqual(moved.map((item) => item.position), [0, 1, 2]);
  assert.deepEqual(queue.map((item) => item.episode.id), ["one", "two", "three"]);

  assert.equal(movePodcastQueueItem(queue, "one", -1), queue);
  assert.equal(movePodcastQueueItem(queue, "missing", 1), queue);
});
