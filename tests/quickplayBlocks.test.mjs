import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildContinueBlock,
  buildForgottenFavoritesBlock,
  buildHistoryBlock,
  buildMostPlayedBlock,
  buildQuickplayBlocks,
} from "../.tmp/visualizer-tests/utils/quickplayBlocks.js";

const quickplaySource = readFileSync("src/views/QuickplayView.tsx", "utf8");

function albumGroup(key, album, artist, tracks) {
  return { key, album, artist, tracks, coverPath: null };
}

test("continue without an active track falls back to the most recently played album", () => {
  const alphaTracks = [track("alpha-1", { album: "Aardvark", artist: "Alpha" })];
  const zetaTracks = [track("zeta-1", { album: "Zebra", artist: "Zeta" })];
  const albums = [
    albumGroup("aardvark\0alpha", "Aardvark", "Alpha", alphaTracks),
    albumGroup("zebra\0zeta", "Zebra", "Zeta", zetaTracks),
  ];
  const activity = {
    "alpha-1": { addedAt: 1, playCount: 1, completedCount: 0, skipCount: 0, lastPlayedAt: 100 },
    "zeta-1": { addedAt: 1, playCount: 1, completedCount: 0, skipCount: 0, lastPlayedAt: 200 },
  };
  const block = buildContinueBlock({
    tracks: [...alphaTracks, ...zetaTracks],
    albums,
    playlists: [],
    activity,
    favoriteTrackIds: new Set(),
    historyIds: [],
    activeTrack: null,
  });
  // Not the alphabetically first album: the one actually listened to last.
  assert.equal(block?.items[0]?.id, "zebra\0zeta");
});

test("continue with no play history falls back to the most recently added album", () => {
  const oldTracks = [track("old-1", { album: "Aardvark", artist: "Alpha", added_at: 10 })];
  const newTracks = [track("new-1", { album: "Zebra", artist: "Zeta", added_at: 20 })];
  const block = buildContinueBlock({
    tracks: [...oldTracks, ...newTracks],
    albums: [
      albumGroup("aardvark\0alpha", "Aardvark", "Alpha", oldTracks),
      albumGroup("zebra\0zeta", "Zebra", "Zeta", newTracks),
    ],
    playlists: [],
    activity: {},
    favoriteTrackIds: new Set(),
    historyIds: [],
    activeTrack: null,
  });
  assert.equal(block?.items[0]?.id, "zebra\0zeta");
});

test("history dedups by album identity, not by album name", () => {
  const tracks = [
    track("one", { album: "Greatest Hits", artist: "Alpha" }),
    track("two", { album: "Greatest Hits", artist: "Beta" }),
  ];
  const block = buildHistoryBlock({
    tracks,
    albums: [],
    playlists: [],
    activity: {},
    favoriteTrackIds: new Set(),
    historyIds: ["one", "two"],
    activeTrack: null,
  });
  // Real history ids only — both recent plays appear even if albums share a name.
  assert.deepEqual(block.items.map((item) => item.id), ["one", "two"]);
});

test("history never pads with library order and keeps one track per item", () => {
  const tracks = [
    track("one", { album: "A", artist: "Alpha" }),
    track("two", { album: "B", artist: "Beta" }),
    track("three", { album: "C", artist: "Gamma" }),
  ];
  const block = buildHistoryBlock({
    tracks,
    albums: [],
    playlists: [],
    activity: {},
    favoriteTrackIds: new Set(),
    historyIds: ["two"],
    activeTrack: null,
  });
  assert.deepEqual(block.items.map((item) => item.id), ["two"]);
  assert.deepEqual(block.items[0]?.tracks.map((item) => item.id), ["two"]);
});

test("most played items expose the ranked track itself, not the library head", () => {
  const tracks = [
    track("a", { title: "A" }),
    track("b", { title: "B" }),
  ];
  const block = buildMostPlayedBlock({
    tracks,
    albums: [],
    playlists: [],
    activity: {
      a: { addedAt: 1, playCount: 1, completedCount: 0, skipCount: 0, lastPlayedAt: 10 },
      b: { addedAt: 1, playCount: 9, completedCount: 4, skipCount: 0, lastPlayedAt: 20 },
    },
    favoriteTrackIds: new Set(),
    historyIds: [],
    activeTrack: null,
  });
  assert.equal(block.items[0]?.id, "b");
  assert.deepEqual(block.items[0]?.tracks.map((item) => item.id), ["b"]);
});

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

test("the view consumes buildQuickplayBlocks and never re-implements the continue fallback", () => {
  // The production regression: QuickplayView had its own albumForTrack whose
  // no-history fallback returned the alphabetically first album. The view
  // must consume the tested builder instead.
  assert.ok(quickplaySource.includes("buildQuickplayBlocks(blockInput)"));
  assert.ok(!quickplaySource.includes("albums[0]"), "view must not fall back to the alphabetically first album");
  assert.ok(!quickplaySource.includes("function albumForTrack"), "view must not shadow the tested continue logic");
  // A podcast owns the shared audio element; continue must not resume it.
  assert.ok(quickplaySource.includes("podcastActive"));
});
