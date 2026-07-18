import assert from "node:assert/strict";
import test from "node:test";
import {
  createTrackActivity,
  defaultSmartPlaylistConfig,
  evaluateSmartPlaylist,
  resolvePlaylistTracks,
  smartRule,
} from "../.tmp/visualizer-tests/utils/smartPlaylist.js";

function track(id, overrides = {}) {
  return {
    id,
    path: `${id}.mp3`,
    file_name: `${id}.mp3`,
    title: id,
    artist: "Artist",
    album: "Album",
    extension: "mp3",
    duration_seconds: 180,
    genres: [],
    ...overrides,
  };
}

const now = Date.UTC(2026, 6, 18);

test("metadata and behavior rules can be combined", () => {
  const tracks = [
    track("match", { year: 1995, genres: ["Alternative Rock"] }),
    track("wrong-year", { year: 2005, genres: ["Alternative Rock"] }),
    track("wrong-genre", { year: 1995, genres: ["Jazz"] }),
  ];
  const config = {
    ...defaultSmartPlaylistConfig(),
    rules: [smartRule("genre", "contains", "rock"), smartRule("year", "between", 1990, 1999)],
  };

  const result = evaluateSmartPlaylist(config, tracks, { favoriteTrackIds: new Set(), activity: {}, now });
  assert.deepEqual(result.tracks.map((item) => item.id), ["match"]);
  assert.equal(result.matchedCount, 1);
});

test("forgotten rules include never-played music and reject recent plays", () => {
  const tracks = [track("never"), track("old"), track("recent")];
  const activity = {
    old: { ...createTrackActivity(undefined, now), lastPlayedAt: now - 100 * 86_400_000, playCount: 2 },
    recent: { ...createTrackActivity(undefined, now), lastPlayedAt: now - 5 * 86_400_000, playCount: 2 },
  };
  const config = {
    ...defaultSmartPlaylistConfig(),
    rules: [smartRule("lastPlayed", "olderThanDays", 30)],
  };

  const result = evaluateSmartPlaylist(config, tracks, { favoriteTrackIds: new Set(), activity, now });
  assert.deepEqual(new Set(result.tracks.map((item) => item.id)), new Set(["never", "old"]));
});

test("diversity caps and duration limits are applied after matching", () => {
  const tracks = [
    track("a1", { artist: "A", album: "A1" }),
    track("a2", { artist: "A", album: "A2" }),
    track("b1", { artist: "B", album: "B1" }),
    track("c1", { artist: "C", album: "C1" }),
  ];
  const config = {
    ...defaultSmartPlaylistConfig(),
    order: "title",
    limitKind: "minutes",
    limitValue: 6,
    maxPerArtist: 1,
    maxPerAlbum: 0,
  };

  const result = evaluateSmartPlaylist(config, tracks, { favoriteTrackIds: new Set(), activity: {}, now });
  assert.deepEqual(result.tracks.map((item) => item.id), ["a1", "b1"]);
});

test("manual playlists preserve their stored order", () => {
  const tracks = [track("one"), track("two")];
  const playlist = { id: "manual", name: "Manual", description: "", kind: "manual", trackIds: ["two", "one"] };
  const result = resolvePlaylistTracks(playlist, tracks, { favoriteTrackIds: new Set(), activity: {}, now });
  assert.deepEqual(result.tracks.map((item) => item.id), ["two", "one"]);
});

test("unfinished text rules stay neutral while editing", () => {
  const tracks = [track("tagged", { genres: ["Rock"] }), track("untagged")];
  const config = {
    ...defaultSmartPlaylistConfig(),
    match: "any",
    rules: [smartRule("genre", "contains", "")],
  };
  const result = evaluateSmartPlaylist(config, tracks, { favoriteTrackIds: new Set(), activity: {}, now });
  assert.equal(result.matchedCount, 2);
  assert.equal(result.missingMetadataCount, 0);
});
