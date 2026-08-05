import assert from "node:assert/strict";
import test from "node:test";
import {
  buildForgottenFavoritesBlock,
  buildMostPlayedBlock,
  buildQuickplayBlocks,
} from "../.tmp/visualizer-tests/utils/quickplayBlocks.js";

function track(id, overrides = {}) {
  return {
    id,
    path: `/music/${id}.mp3`,
    file_name: `${id}.mp3`,
    title: overrides.title ?? id,
    artist: overrides.artist ?? "Artist",
    album: overrides.album ?? "Album",
    album_artist: overrides.artist ?? "Artist",
    extension: "mp3",
    added_at: overrides.added_at ?? 1,
    cover_path: null,
    ...overrides,
  };
}

test("most played ranks by playCount then recency", () => {
  const tracks = [
    track("a", { title: "A" }),
    track("b", { title: "B" }),
    track("c", { title: "C" }),
  ];
  const activity = {
    a: { addedAt: 1, playCount: 5, completedCount: 2, skipCount: 0, lastPlayedAt: 10 },
    b: { addedAt: 1, playCount: 9, completedCount: 4, skipCount: 1, lastPlayedAt: 20 },
    c: { addedAt: 1, playCount: 9, completedCount: 3, skipCount: 0, lastPlayedAt: 30 },
  };
  const block = buildMostPlayedBlock({
    tracks,
    albums: [],
    playlists: [],
    activity,
    favoriteTrackIds: new Set(),
    historyIds: [],
    activeTrack: null,
  });
  assert.deepEqual(block.items.map((item) => item.id), ["c", "b", "a"]);
  assert.equal(block.title, "最常播放");
});

test("forgotten favorites keeps only stale favorites", () => {
  const now = 1000 * 60 * 60 * 24 * 100; // day 100
  const tracks = [
    track("fresh"),
    track("stale"),
    track("never"),
    track("other"),
  ];
  const activity = {
    fresh: { addedAt: 1, playCount: 3, completedCount: 1, skipCount: 0, lastPlayedAt: now - 1000 },
    stale: { addedAt: 1, playCount: 2, completedCount: 1, skipCount: 0, lastPlayedAt: now - 1000 * 60 * 60 * 24 * 40 },
    never: { addedAt: 1, playCount: 0, completedCount: 0, skipCount: 0 },
    other: { addedAt: 1, playCount: 4, completedCount: 1, skipCount: 0, lastPlayedAt: now - 1000 * 60 * 60 * 24 * 50 },
  };
  const block = buildForgottenFavoritesBlock({
    tracks,
    albums: [],
    playlists: [{
      id: "favorites",
      name: "收藏",
      description: "",
      kind: "manual",
      trackIds: ["fresh", "stale", "never"],
    }],
    activity,
    favoriteTrackIds: new Set(["fresh", "stale", "never"]),
    historyIds: [],
    activeTrack: null,
    now,
  }, { olderThanDays: 30 });

  assert.deepEqual(block.items.map((item) => item.id), ["never", "stale"]);
  assert.equal(block.title, "久违收藏");
});

test("quickplay blocks omit empty auto sections", () => {
  const tracks = [track("only")];
  const blocks = buildQuickplayBlocks({
    tracks,
    albums: [{
      key: "Album::Artist",
      artist: "Artist",
      album: "Album",
      tracks,
      coverPath: null,
    }],
    playlists: [],
    activity: {
      only: { addedAt: 1, playCount: 0, completedCount: 0, skipCount: 0 },
    },
    favoriteTrackIds: new Set(),
    historyIds: [],
    activeTrack: tracks[0],
  });
  const ids = blocks.map((block) => block.id);
  assert.ok(ids.includes("continue"));
  assert.ok(ids.includes("recentAdded"));
  // history intentionally hides the active album-only case.
  assert.ok(!ids.includes("history"));
  assert.ok(!ids.includes("mostPlayed"));
  assert.ok(!ids.includes("forgottenFavorites"));
});
