import assert from "node:assert/strict";
import test from "node:test";
import { searchLibrary } from "../.tmp/visualizer-tests/utils/librarySearch.js";
import { defaultSmartPlaylistConfig, smartRule } from "../.tmp/visualizer-tests/utils/smartPlaylist.js";

function track(id, overrides = {}) {
  return {
    id,
    path: `${id}.mp3`,
    file_name: `${id}.mp3`,
    title: id,
    artist: "默认艺术家",
    album: "默认专辑",
    extension: "mp3",
    ...overrides,
  };
}

function album(key, name, artist, tracks) {
  return { key, album: name, artist, tracks, coverPath: null };
}

function artist(name, tracks) {
  return { artist: name, tracks };
}

function search(input) {
  return searchLibrary({
    query: input.query,
    tracks: input.tracks,
    albums: input.albums,
    artists: input.artists,
    playlists: input.playlists ?? [],
    favoriteTrackIds: new Set(),
    activity: {},
  });
}

test("search groups matching artists, albums, songs, and playlists", () => {
  const eminem = track("em-song", {
    title: "Lose Yourself",
    artist: "Eminem",
    album: "8 Mile",
  });
  const unrelated = track("other", { title: "白日梦蓝", artist: "刺猬", album: "白日梦蓝" });
  const results = search({
    query: "em",
    tracks: [eminem, unrelated],
    albums: [album("8-mile", "8 Mile", "Eminem", [eminem])],
    artists: [artist("Eminem", [eminem]), artist("刺猬", [unrelated])],
    playlists: [{
      id: "workout",
      name: "运动",
      description: "",
      trackIds: [eminem.id],
    }],
  });

  assert.deepEqual(results.artists.map((item) => item.artist), ["Eminem"]);
  assert.deepEqual(results.albums.map((item) => item.key), ["8-mile"]);
  assert.deepEqual(results.tracks.map((item) => item.id), ["em-song"]);
  assert.deepEqual(results.playlists.map((item) => item.playlist.id), ["workout"]);
  assert.equal(results.total, 4);
});

test("exact and prefix title matches rank before contained matches", () => {
  const exact = track("exact", { title: "Em" });
  const prefix = track("prefix", { title: "Emerge" });
  const contained = track("contained", { title: "Remember" });
  const results = search({
    query: "EM",
    tracks: [contained, prefix, exact],
    albums: [],
    artists: [],
  });

  assert.deepEqual(results.tracks.map((item) => item.id), ["exact", "prefix", "contained"]);
});

test("blank queries do not create a synthetic result page", () => {
  const onlyTrack = track("only");
  const results = search({
    query: "   ",
    tracks: [onlyTrack],
    albums: [album("only", "默认专辑", "默认艺术家", [onlyTrack])],
    artists: [artist("默认艺术家", [onlyTrack])],
  });

  assert.equal(results.total, 0);
  assert.deepEqual(results.tracks, []);
});

test("rank ties retain legacy multilingual numeric collation and stable equivalent labels", () => {
  const titles = ["歌曲 10", "歌曲 2", "歌曲 é", "歌曲 e", "歌曲 Ａ", "歌曲 A", "歌曲 a", "歌曲 中", "歌曲 重庆"];
  const tracks = titles.map((title, index) => track(`id-${index}`, { title }));
  // Compare against the former API on this runtime's ICU data, including case/width ties.
  const expected = [...tracks].sort((a, b) => a.title.localeCompare(b.title, "zh-CN", { numeric: true })).map(item => item.id);
  const result = search({ query: "歌曲", tracks, albums: [], artists: [] });
  assert.deepEqual(result.tracks.map(item => item.id), expected);
  assert.ok(expected.indexOf("id-1") < expected.indexOf("id-0"));
  assert.deepEqual(tracks.map(item => item.id), titles.map((_, index) => `id-${index}`));
});

test("shared list lookup preserves missing entries, duplicates and original manual order", () => {
  const one = track("one", { title: "needle one" }), two = track("two", { title: "needle two" });
  const lists = [
    { id: "a", name: "first", description: "", trackIds: ["missing", "two", "one", "two"] },
    { id: "b", name: "second", description: "", trackIds: ["one"] },
  ];
  const result = search({ query: "needle", tracks: [one, two], albums: [], artists: [], playlists: lists });
  assert.deepEqual(result.playlists.map(item => [item.playlist.id, item.tracks.map(t => t.id)]), [
    ["a", ["two", "one", "two"]], ["b", ["one"]],
  ]);
  assert.deepEqual(lists[0].trackIds, ["missing", "two", "one", "two"]);
  one.title = "changed";two.title = "changed";
  assert.equal(search({ query: "needle", tracks: [one, two], albums: [], artists: [], playlists: lists }).total, 0);
});

test("search keeps smart rules, favorites and exclusions while sharing manual resolutions", () => {
  const tracks = [track("a", { title: "needle a" }), track("b", { title: "needle b" }), track("c", { title: "needle c" })];
  const playlists = [{ id: "smart", kind: "smart", name: "smart", description: "", excludedTrackIds: ["b"],
    smart: { ...defaultSmartPlaylistConfig(), rules: [smartRule("favorite", "is", true)], rotateDaily: false } },
    { id: "manual", name: "manual", description: "", trackIds: ["c", "a"] }];
  const result = searchLibrary({ query: "needle", tracks, playlists, albums: [], artists: [], favoriteTrackIds: new Set(["a", "b"]), activity: {} });
  assert.deepEqual(result.playlists.find(item => item.playlist.id === "smart").tracks.map(t => t.id), ["a"]);
  assert.deepEqual(result.playlists.find(item => item.playlist.id === "manual").tracks.map(t => t.id), ["c", "a"]);
});

test("empty metadata and duplicate IDs keep global scoring separate from last-record playlist lookup", () => {
  const stale = track("duplicate", { title: "stale", artist: "", album: "", file_name: "" });
  const current = track("duplicate", { title: "needle current", artist: "", album: "", file_name: "" });
  const emptyTitle = track("empty", { title: "", artist: "needle artist", album: "", file_name: "" });
  const lists = [{ id: "manual", name: "list", description: "", trackIds: ["duplicate", "empty"] }];
  const result = search({ query: "needle", tracks: [stale, current, emptyTitle], albums: [], artists: [], playlists: lists });
  assert.deepEqual(result.tracks, [current, emptyTitle]);
  assert.deepEqual(result.playlists[0].tracks, [current, emptyTitle]);
  const reordered = search({ query: "needle", tracks: [current, stale, emptyTitle], albums: [], artists: [], playlists: lists });
  assert.deepEqual(reordered.tracks, [current, emptyTitle]);
  assert.deepEqual(reordered.playlists[0].tracks, [stale, emptyTitle]);
});
