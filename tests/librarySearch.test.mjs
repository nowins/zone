import assert from "node:assert/strict";
import test from "node:test";
import { searchLibrary } from "../.tmp/visualizer-tests/utils/librarySearch.js";

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
