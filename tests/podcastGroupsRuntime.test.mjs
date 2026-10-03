import assert from "node:assert/strict";
import test from "node:test";
import { mountPodcastHook, runtime, podcastFeed, step } from "./helpers/podcastRuntime.mjs";

test("grouped custom ordering moves between visible shows while retaining hidden shows", async () => {
  const feeds = ["a", "b", "c"].map(id => ({ ...podcastFeed, id, title: id, feedUrl: `https://example.com/${id}.xml` }));
  const props = { queue: [], autoQueueMode: "off", activeEpisode: null, activeEpisodeId: null, activeProgress: 0, activeDuration: 0, libraryRevision: 0, episodeRequest: null, feedRequest: null, pinnedPodcastFeedIds: new Set(), onEpisodeUpdated() {} };
  const h = await mountPodcastHook(runtime.usePodcastViewModel, props, async command => {
    if (command === "podcast_list_feeds") return feeds;
    if (command === "podcast_list_home") return {};
    if (command === "podcast_refresh_feeds") return { checked: 0, failures: [] };
    return null;
  });
  try {
    await step(() => h.api.setLibrarySort("custom"));
    await step(() => h.api.moveFollowedFeed("a", 1, ["a", "c"]));
    assert.deepEqual(h.api.orderedFeeds.filter(feed => feed.id !== "b").map(feed => feed.id), ["c", "a"]);
    assert.equal(h.api.orderedFeeds.length, 3);
    await step(() => h.api.moveFollowedFeed("c", -1, ["a", "c"]));
    assert.deepEqual(h.api.orderedFeeds.filter(feed => feed.id !== "b").map(feed => feed.id), ["c", "a"]);
  } finally { await h.close(); }
});
