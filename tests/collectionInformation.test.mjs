import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const librarySource = readFileSync("src/views/LibraryView.tsx", "utf8");
const artistSource = readFileSync("src/views/ArtistBrowser.tsx", "utf8");
const playlistSource = readFileSync("src/views/PlaylistBrowser.tsx", "utf8");

test("collection browsers avoid repeating low-value counts on every tile or artist row", () => {
  assert.ok(!librarySource.includes("<small>{album.tracks.length} 首歌曲</small>"));
  assert.ok(!artistSource.includes("<small>{item.albumCount} 张 · {item.tracks.length} 首</small>"));
});

test("section totals remain where they explain the current selection", () => {
  assert.ok(artistSource.includes("{artist.albums.length} 张专辑"));
  assert.ok(artistSource.includes("{artist.tracks.length} 首歌曲"));
  assert.equal(occurrences(playlistSource, "{selected.tracks.length} 首歌曲"), 1);
});

function occurrences(source, text) {
  return source.split(text).length - 1;
}
