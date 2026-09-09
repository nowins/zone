import assert from "node:assert/strict";
import test from "node:test";
import { albumKey, bestAlbumArtist, compareTracksForAlbum, normalizePlaylists } from "../.tmp/visualizer-tests/utils/music.js";

function track(overrides) {
  return {
    id: overrides.id ?? overrides.title,
    path: overrides.path ?? overrides.title,
    file_name: overrides.file_name ?? `${overrides.title}.mp3`,
    title: overrides.title,
    artist: overrides.artist ?? "Track artist",
    album: overrides.album ?? "Album",
    extension: "mp3",
    ...overrides,
  };
}

test("same-named albums from different album artists stay separate", () => {
  assert.notEqual(albumKey("Greatest Hits", "Artist A"), albumKey("Greatest Hits", "Artist B"));
  assert.equal(albumKey(" Greatest Hits ", "ARTIST A"), albumKey("greatest hits", "artist a"));
});

test("embedded track numbers take precedence over filename ordering", () => {
  const first = track({ title: "Zulu", file_name: "99 Zulu.mp3", track_number: 1 });
  const second = track({ title: "Alpha", file_name: "01 Alpha.mp3", track_number: 2 });
  assert.ok(compareTracksForAlbum(first, second) < 0);
});

test("album artist metadata controls the displayed album artist", () => {
  const tracks = [
    track({ title: "One", artist: "Guest A", album_artist: "Compilation Artist" }),
    track({ title: "Two", artist: "Guest B", album_artist: "Compilation Artist" }),
  ];
  assert.equal(bestAlbumArtist(tracks), "Compilation Artist");
});

test("legacy favorites playlist is localized when restored", () => {
  const playlists = normalizePlaylists([
    { id: "favorites", name: "favorites", description: "saved playlist", trackIds: ["one"] },
  ]);

  assert.equal(playlists[0].name, "喜欢的歌曲");
  assert.equal(playlists[0].description, "标记为喜欢的歌曲");
  assert.deepEqual(playlists[0].trackIds, ["one"]);
});
