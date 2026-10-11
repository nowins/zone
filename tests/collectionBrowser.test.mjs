import assert from "node:assert/strict";
import test from "node:test";
import { buildCollectionIndex, albumReference, artistReference } from "../.tmp/visualizer-tests/utils/collectionEntities.js";
import { buildCollectionGenres, initialCollectionBrowser, resolveCollectionBrowser, sortCollectionTracks, nextCollectionTrackSort } from "../.tmp/visualizer-tests/utils/collectionBrowser.js";

const tracks = [
  { id: "first", title: "Zebra", artist: "Guest", album_artist: "Host", album: "Shared", track_number: 1, genres: [" Rock ", "rock", "Jazz"], duration_seconds: 50 },
  { id: "second", title: "Alpha", artist: "Host", album_artist: "Host", album: "Shared", track_number: 2, genres: ["Pop"], duration_seconds: 200 },
  { id: "third", title: "Alpha", artist: "Host", album: "Other", genres: ["Rock"], duration_seconds: null },
  { id: "missing", title: "Unknown", artist: "AC/DC", album: "Single", genres: ["  "], duration_seconds: NaN },
].map(track => ({ path: track.id, file_name: track.id + ".flac", extension: "flac", ...track }));
const ids = items => items.map(track => track.id);

test("unselected browsers show the complete library without implicitly choosing the first item", () => {
  const index = buildCollectionIndex(tracks);
  for (const view of ["artists", "albums", "genres"]) {
    const scope = resolveCollectionBrowser(index, view, initialCollectionBrowser());
    assert.equal(scope.album, null);
    assert.equal(scope.artist, null);
    assert.equal(scope.genre, null);
    assert.equal(scope.albums.length, 3);
    assert.deepEqual(new Set(ids(scope.tracks)), new Set(ids(tracks)));
  }
});

test("genre scopes include each matching song once and group albums by album artist", () => {
  const index = buildCollectionIndex(tracks), genres = buildCollectionGenres(tracks);
  const rock = genres.find(item => item.name.toLowerCase() === "rock");
  assert.deepEqual(ids(rock.tracks), ["first", "third"]);
  assert.equal(genres.find(item => item.key === "missing").name, "未知流派");
  const state = { ...initialCollectionBrowser(), genre: rock.key };
  const scope = resolveCollectionBrowser(index, "genres", state, genres);
  assert.equal(scope.albums.length, 2);
  assert.deepEqual(scope.albumGroups.map(group => group.name), ["Host"]);
  const selected = resolveCollectionBrowser(index, "genres", { ...state, albums: { ...state.albums, genres: albumReference(index.albumByTrackId.get("first")) } });
  assert.deepEqual(ids(selected.tracks), ["first"], "mixed-genre albums cannot leak nonmatching songs into this scope");
  assert.equal(index.artistsByName.has("AC"), false, "raw artist credits stay intact");
});

test("artist roles, album track order and removed selections resolve from stable song anchors", () => {
  const index = buildCollectionIndex(tracks);
  const state = { ...initialCollectionBrowser(), artist: artistReference(index.artistsByName.get("Host")) };
  assert.deepEqual(new Set(ids(resolveCollectionBrowser(index, "artists", state).tracks)), new Set(["first", "second", "third"]));
  state.albums.artists = albumReference(index.albumByTrackId.get("first"));
  assert.deepEqual(ids(resolveCollectionBrowser(index, "artists", state).tracks), ["first", "second"]);
  const renamed = buildCollectionIndex(tracks.map(track => ({ ...track, artist: track.artist === "Host" ? "Renamed" : track.artist, album_artist: track.album_artist === "Host" ? "Renamed" : track.album_artist })));
  assert.equal(resolveCollectionBrowser(renamed, "artists", state).artist.artist, "Renamed");
  const removed = resolveCollectionBrowser(buildCollectionIndex([]), "artists", state);
  assert.equal(removed.primaryMissing, true);
  assert.equal(removed.albumMissing, true);
  assert.deepEqual(removed.tracks, []);
});

test("column sorting is stable, natural, nonmutating and keeps unknown duration last", () => {
  const original = ids(tracks);
  assert.deepEqual(ids(sortCollectionTracks(tracks, { field: "title", direction: "ascending" })), ["second", "third", "missing", "first"]);
  assert.deepEqual(ids(sortCollectionTracks(tracks, { field: "title", direction: "descending" })), ["first", "missing", "second", "third"]);
  assert.deepEqual(ids(sortCollectionTracks(tracks, { field: "duration", direction: "ascending" })), ["first", "second", "third", "missing"]);
  assert.deepEqual(ids(sortCollectionTracks(tracks, { field: "duration", direction: "descending" })), ["second", "first", "third", "missing"]);
  assert.equal(sortCollectionTracks(tracks, { field: "genre", direction: "ascending" }).at(-1).id, "missing");
  assert.deepEqual(ids(tracks), original);
  assert.deepEqual(nextCollectionTrackSort({ field: "title", direction: "ascending" }, "title"), { field: "title", direction: "descending" });
  assert.deepEqual(nextCollectionTrackSort({ field: "title", direction: "descending" }, "album"), { field: "album", direction: "ascending" });
});
