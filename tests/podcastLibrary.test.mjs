import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  groupPodcastDownloads,
  movePodcastFeedOrder,
  normalizePodcastFeedOrder,
  podcastDownloadedBytes,
  sortPodcastFeeds,
} from "../.tmp/visualizer-tests/utils/podcastLibrary.js";

const podcastViewSource = readFileSync(
  new URL("../src/views/PodcastView.tsx", import.meta.url),
  "utf8",
);
const podcastStylesSource = readFileSync(
  new URL("../src/styles/podcasts.css", import.meta.url),
  "utf8",
);
const appSource = readFileSync(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);

function feed(id, title, overrides = {}) {
  return {
    id,
    feedUrl: `https://example.com/${id}.xml`,
    title,
    lastFetchedAt: 1,
    subscribed: true,
    unplayedCount: 0,
    ...overrides,
  };
}

function episode(id, feedId, downloadedBytes, overrides = {}) {
  return {
    id,
    feedId,
    title: `单集 ${id}`,
    enclosureUrl: `https://example.com/${id}.mp3`,
    downloadState: "downloaded",
    downloadedBytes,
    progressSeconds: 0,
    completed: false,
    saved: false,
    firstSeenAt: 1,
    ...overrides,
  };
}

test("podcast library sorting is immutable and supports recent, name, and custom order", () => {
  const feeds = [
    feed("b", "播客 10", { latestEpisodeAt: 20 }),
    feed("a", "播客 2", { latestEpisodeAt: 30 }),
    feed("c", "播客 1", { latestEpisodeAt: null }),
  ];

  assert.deepEqual(
    sortPodcastFeeds(feeds, "recent").map(({ id }) => id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    sortPodcastFeeds(feeds, "name").map(({ id }) => id),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    sortPodcastFeeds(feeds, "custom", ["b", "c"]).map(({ id }) => id),
    ["b", "c", "a"],
  );
  assert.deepEqual(feeds.map(({ id }) => id), ["b", "a", "c"]);

  const undated = [
    feed("b", "同名", { latestEpisodeAt: null }),
    feed("c", "乙节目", { latestEpisodeAt: undefined }),
    feed("a", "同名", { latestEpisodeAt: null }),
    feed("d", "甲节目", { latestEpisodeAt: null }),
  ];
  assert.deepEqual(
    sortPodcastFeeds(undated, "recent").map(({ id }) => id),
    ["d", "a", "b", "c"],
  );
});

test("custom podcast order removes stale duplicates and appends new subscriptions", () => {
  const feeds = [feed("a", "甲"), feed("b", "乙"), feed("c", "丙")];

  assert.deepEqual(
    normalizePodcastFeedOrder(["b", "missing", "b"], feeds),
    ["b", "a", "c"],
  );
  assert.deepEqual(
    movePodcastFeedOrder(["a", "b", "c"], "c", "a"),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    movePodcastFeedOrder(["a", "b"], "missing", "a"),
    ["a", "b"],
  );
});

test("download grouping preserves first-seen podcast order and totals safe byte counts", () => {
  const episodes = [
    episode("a1", "a", 20, {
      feedTitle: "甲节目",
      feedArtworkUrl: "https://example.com/a.jpg",
    }),
    episode("b1", "b", 15, { feedTitle: "乙节目" }),
    episode("a2", "a", -4, {
      feedTitle: "甲节目",
      artworkUrl: "https://example.com/a-episode.jpg",
    }),
  ];

  const groups = groupPodcastDownloads(episodes);
  assert.deepEqual(groups.map(({ feedId }) => feedId), ["a", "b"]);
  assert.deepEqual(groups[0].episodes.map(({ id }) => id), ["a1", "a2"]);
  assert.equal(groups[0].downloadedBytes, 20);
  assert.equal(groups[0].artworkUrl, "https://example.com/a.jpg");
  assert.equal(podcastDownloadedBytes(episodes), 35);

  const fallbackArtwork = groupPodcastDownloads([
    episode("c1", "c", 1, { feedTitle: "丙节目" }),
    episode("c2", "c", 2, {
      feedTitle: "丙节目",
      artworkUrl: "https://example.com/c.jpg",
    }),
  ]);
  assert.equal(fallbackArtwork[0].artworkUrl, "https://example.com/c.jpg");
});

test("podcast library exposes durable sorting, unread state, history, and grouped storage", () => {
  assert.match(podcastViewSource, /zone-podcast-library-v1/);
  assert.match(podcastViewSource, /aria-label="已关注节目排序"/);
  assert.match(podcastViewSource, /podcast-unplayed-badge/);
  assert.match(podcastViewSource, /recentHistoryExpanded/);
  assert.match(podcastViewSource, /recentlyPlayedEpisodes\.slice\(0, 8\)/);
  assert.match(
    podcastViewSource,
    /groupPodcastDownloads\(libraryDownloadedEpisodes\)/,
  );
  assert.match(
    podcastViewSource,
    /已下载占用\s+\{formatFileSize\(downloadedBytes\)\}/,
  );
  assert.match(podcastViewSource, /podcast_list_downloads/);
  assert.match(podcastStylesSource, /\.podcast-download-group-title/);
  assert.match(podcastStylesSource, /\.podcast-library-order button/);
  assert.match(appSource, /podcastProgressStartedRef/);
  assert.match(
    appSource,
    /positionSeconds > 0[\s\S]*setPodcastLibraryRevision/,
  );
});
