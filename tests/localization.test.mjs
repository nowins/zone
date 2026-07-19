import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync("src/App.tsx", "utf8");
const artistSource = readFileSync("src/views/ArtistBrowser.tsx", "utf8");
const librarySource = readFileSync("src/views/LibraryView.tsx", "utf8");
const nowPlayingSource = readFileSync("src/views/NowPlayingView.tsx", "utf8");
const settingsSource = readFileSync("src/views/SettingsView.tsx", "utf8");
const playlistSource = readFileSync("src/views/PlaylistBrowser.tsx", "utf8");
const emptySource = readFileSync("src/components/EmptyState.tsx", "utf8");
const titlebarSource = readFileSync("src/components/Titlebar.tsx", "utf8");

test("collection totals are shown once and use Chinese units", () => {
  assert.ok(!artistSource.includes("<p>{artists.length}"));
  assert.ok(artistSource.includes("{artistAlbums.length} 张专辑"));
  assert.ok(artistSource.includes("{visibleSongs.length} 首歌曲"));
  assert.ok(!settingsSource.includes("settings-summary"));
  assert.equal(occurrences(playlistSource, "{selected.tracks.length} 首歌曲"), 1);
  assert.ok(playlistSource.includes('"收藏的歌曲"'));
  assert.ok(playlistSource.includes('"自定义播放列表"'));
  assert.ok(playlistSource.includes('name: "正在播放"'));
  assert.ok(!playlistSource.includes('name: "now playing"'));
});

test("functional UI copy does not fall back to English", () => {
  const source = [
    appSource,
    artistSource,
    librarySource,
    nowPlayingSource,
    emptySource,
    titlebarSource,
  ].join("\n");

  for (const englishCopy of [
    "artists</p>",
    "albums</p>",
    "songs</p>",
    "nothing playing",
    "choose a song",
    "save as playlist",
    "Save playlist",
    "add music folder",
    "no album selected",
    'title="Minimize"',
    'title="Maximize"',
    'title="Close"',
    "songs indexed",
  ]) {
    assert.ok(!source.includes(englishCopy), `unexpected English UI copy: ${englishCopy}`);
  }
});

function occurrences(source, value) {
  return source.split(value).length - 1;
}
