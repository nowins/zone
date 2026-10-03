import assert from "node:assert/strict";
import test from "node:test";
import { deferred, mountPodcastHook, runtime, step } from "./helpers/podcastRuntime.mjs";

const props = { queue: [], autoQueueMode: "off", activeEpisode: null, activeEpisodeId: null,
  activeProgress: 0, activeDuration: 0, libraryRevision: 0, episodeRequest: null, feedRequest: null,
  pinnedPodcastFeedIds: new Set(), onEpisodeUpdated() {} };
const page = (extra = {}) => ({ source: "xyzrank", stale: false, fetchedAt: Date.now(),
  shows: [{ id: "rank", title: "中文节目", author: "作者", feedUrl: "https://example.com/feed", genres: [], rank: 1 }], ...extra });
async function mount(invoke) {
  runtime.setDiscoveryCache(null);
  return mountPodcastHook(runtime.usePodcastViewModel, props, async (command, args) => {
    if (command === "podcast_list_home") return {};
    if (command === "podcast_refresh_feeds") return { checked: 0, failures: [] };
    if (command === "podcast_load_discovery_cache" || command === "podcast_browse_discovery"
      || command === "podcast_cancel_network_request") return invoke(command, args);
    return [];
  });
}

test("StrictMode discovery hydrates fresh SQLite data before issuing any network request", async () => {
  const cached = page(); const calls = [];
  const harness = await mount(async command => { calls.push(command); return cached; });
  try {
    await step(() => harness.api.changeRootScreen("discover"));
    assert.deepEqual(calls, ["podcast_load_discovery_cache"]);
    assert.equal(harness.api.discoveryState, "ready");
    assert.deepEqual(harness.api.discoveryShows, cached.shows);
    assert.equal(harness.api.discoverySourceLabel, "XYZRank 中文榜");
    assert.equal(harness.api.discoveryRefreshing, false);
  } finally { await harness.close(); }
});

test("stale discovery stays visible during refresh and failure cannot advance its timestamp", async () => {
  const cached = page({ stale: true, fetchedAt: Date.now() - 900_001 }); const network = deferred();
  const harness = await mount(command => command === "podcast_load_discovery_cache" ? cached : network.promise);
  try {
    await step(() => harness.api.changeRootScreen("discover"));
    assert.equal(harness.api.discoveryState, "ready");
    assert.deepEqual(harness.api.discoveryShows, cached.shows);
    assert.equal(harness.api.discoveryRefreshing, true);
    assert.equal(harness.api.discoverySourceLabel, "XYZRank 中文榜 · 缓存");
    await step(() => network.reject("offline"));
    assert.equal(harness.api.discoveryState, "ready");
    assert.equal(harness.api.discoveryRefreshing, false);
    assert.equal(runtime.discoveryCache.fetchedAt, cached.fetchedAt);
    assert.deepEqual(runtime.discoveryCache.shows, cached.shows);
  } finally { await harness.close(); }
});

test("manual discovery refresh bypasses a fresh snapshot and displays the actual fallback source", async () => {
  const cached = page(); const fallback = page({ source: "apple", shows: [{ ...cached.shows[0], title: "备用节目" }] });
  const calls = [];
  const harness = await mount(async command => { calls.push(command); return command === "podcast_load_discovery_cache" ? cached : fallback; });
  try {
    await step(() => harness.api.changeRootScreen("discover"));
    await step(() => harness.api.loadDiscovery(true));
    assert.deepEqual(calls, ["podcast_load_discovery_cache", "podcast_browse_discovery"]);
    assert.equal(harness.api.discoverySourceLabel, "Apple 中国区 · 备用来源");
    assert.equal(harness.api.discoveryShows[0].title, "备用节目");
  } finally { await harness.close(); }
});

test("a late SQLite read after leaving the view cannot start networking or fill the memory cache", async () => {
  const disk = deferred(); const calls = [];
  const harness = await mount(command => { calls.push(command); return disk.promise; });
  await step(() => harness.api.changeRootScreen("discover"));
  assert.equal(harness.api.discoveryState, "loading");
  await harness.close();
  await step(() => disk.resolve(page()));
  assert.deepEqual(calls, ["podcast_load_discovery_cache"]);
  assert.equal(runtime.discoveryCache, null);
});

test("a late provider response after unmount is canceled and cannot replace discovery cache", async () => {
  const network = deferred(); const calls = [];
  const harness = await mount((command, args) => {
    calls.push({ command, args });
    if (command === "podcast_load_discovery_cache") return null;
    if (command === "podcast_cancel_network_request") return undefined;
    return network.promise;
  });
  await step(() => harness.api.changeRootScreen("discover"));
  await harness.close();
  assert.equal(calls.at(-1).command, "podcast_cancel_network_request");
  assert.equal(calls.at(-1).args.requestId, calls.find(call => call.command === "podcast_browse_discovery").args.requestId);
  await step(() => network.resolve(page()));
  assert.equal(runtime.discoveryCache, null);
});
