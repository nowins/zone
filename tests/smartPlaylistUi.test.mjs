import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = [
  "src/app/podcastPlaybackSettings.ts",
  "src/hooks/useNavigation.ts",
  "src/hooks/useMusicLibrary.ts",
  "src/hooks/usePodcastPlayback.ts",
  "src/hooks/usePlaybackControls.ts",
  "src/hooks/useAudioEngine.ts",
  "src/hooks/usePlaylists.ts",
  "src/App.tsx",
].map((path) => readFileSync(path, "utf8")).join("\n");
const editorSource = readFileSync("src/components/SmartPlaylistDialog.tsx", "utf8");
const browserSource = readFileSync("src/views/PlaylistBrowser.tsx", "utf8");
const menuSource = readFileSync("src/components/ContextMenu.tsx", "utf8");
const pickerSource = readFileSync("src/components/AddToPlaylistDialog.tsx", "utf8");
const playlistCss = readFileSync("src/styles/playlists.css", "utf8");

test("smart playlist editor starts from presets and keeps a live, explainable preview", () => {
  assert.ok(editorSource.includes("从一个方案开始"));
  assert.ok(editorSource.includes("即时预览"));
  assert.ok(editorSource.includes("匹配歌曲中生成"));
  assert.ok(editorSource.includes('aria-modal="true"'));
  assert.ok(editorSource.includes("每天轮换"));
});

test("smart playlist playback resolves live results but queues a snapshot", () => {
  assert.ok(browserSource.includes("resolvePlaylistTracks"));
  assert.ok(browserSource.includes("resolvePlaylistTracks(playlist, tracks, { favoriteTrackIds, activity })"));
  assert.ok(browserSource.includes("sortCollectionTracks(selected?.tracks || [], sort, favoriteTrackIds)"));
  assert.ok(browserSource.includes("onPlayTracks(displayTracks)"));
  assert.ok(editorSource.includes("当前队列保持不变"));
  assert.ok(appSource.includes("rotationSeed: playlist.smart.rotationSeed + 1"));
});

test("smart playlists cannot be manually nested and support explicit exclusions", () => {
  assert.ok(pickerSource.includes('playlist.kind !== "smart"'));
  assert.ok(menuSource.includes("从这个智能列表中排除"));
  assert.ok(appSource.includes("excludeFromSmartPlaylist"));
});

test("smart editor uses restrained transitions and immediate press feedback", () => {
  assert.ok(playlistCss.includes(".smart-playlist-dialog"));
  assert.ok(playlistCss.includes(".smart-presets button:active"));
  assert.ok(!cssRule(playlistCss, ".smart-playlist-dialog").includes("transition: all"));
});

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[1];
}
