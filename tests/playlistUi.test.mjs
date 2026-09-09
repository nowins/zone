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
const menuSource = readFileSync("src/components/ContextMenu.tsx", "utf8");
const pickerSource = readFileSync("src/components/AddToPlaylistDialog.tsx", "utf8");
const browserSource = readFileSync("src/views/PlaylistBrowser.tsx", "utf8");
const dialogSource = readFileSync("src/components/PlaylistDialog.tsx", "utf8");
const dialogShellSource = readFileSync("src/components/Dialog.tsx", "utf8");
const collectionCss = readFileSync("src/styles/collection.css", "utf8");
const playlistCss = readFileSync("src/styles/playlists.css", "utf8");

test("playlist page presents one total and localized labels", () => {
  assert.ok(!browserSource.includes("playlists.length} playlists"));
  assert.ok(browserSource.includes("新建播放列表"));
  assert.ok(browserSource.includes("当前队列"));
  assert.ok(browserSource.includes("首歌曲"));
  assert.ok(browserSource.includes("description: isCustomManual ? `${result.tracks.length} 首歌曲` : playlistDescription"));
  assert.ok(browserSource.includes('className="playlist-heading"'));
  assert.equal(browserSource.split("{selected.tracks.length} 首歌曲").length - 1, 1);
  assert.ok(browserSource.includes("selected.id !== DEFAULT_PLAYLIST_ID && selected.source?.description"));
  assert.ok(!collectionCss.includes(".playlist-list p"));
  // Header count includes the ephemeral "正在播放" row prepended in PlaylistBrowser.
  assert.ok(readFileSync("src/views/CollectionView.tsx", "utf8").includes("props.playlists.length + 1"));
  assert.ok(!appSource.includes("${playlists.length} 个播放列表"));
});

test("playlist context actions do not offer favorites or self nesting", () => {
  assert.ok(menuSource.includes('!isPlaylist && ('));
  assert.ok(pickerSource.includes("playlist.id !== payload.playlistId"));
  assert.ok(pickerSource.includes('playlist.kind !== "smart"'));
  assert.ok(pickerSource.includes("新建播放列表"));
  assert.ok(appSource.includes("createPlaylistWithTracks"));
  assert.ok(menuSource.includes('sourcePlaylistId !== DEFAULT_PLAYLIST_ID'));
  assert.ok(menuSource.includes("重命名"));
  assert.ok(menuSource.includes("删除播放列表"));
  assert.ok(!menuSource.includes("add to favorites"));
  assert.ok(!menuSource.includes("add to playlist"));
});

test("context menu clamps to the viewport and scrolls when necessary", () => {
  assert.ok(menuSource.includes("window.innerWidth - rect.width"));
  assert.ok(menuSource.includes("window.innerHeight - rect.height"));
  const menuRule = cssRule(playlistCss, ".context-menu");
  assert.ok(menuRule.includes("max-height: calc(100vh - 24px)"));
  assert.ok(menuRule.includes("overflow-y: auto"));
});

test("playlist creation and edits use a modal workflow with feedback", () => {
  assert.ok(dialogSource.includes('mode: "create" | "rename" | "delete"'));
  assert.ok(dialogShellSource.includes("aria-modal=\"true\""));
  assert.ok(dialogShellSource.includes("playlist-dialog-overlay"));
  assert.ok(dialogSource.includes("不会从音乐库中删除"));
  assert.ok(appSource.includes("showActionNotice"));
  assert.ok(appSource.includes("openPlaylistDialog"));
  assert.ok(playlistCss.includes(".playlist-dialog-overlay"));
  assert.ok(playlistCss.includes(".playlist-picker-dialog"));
  assert.ok(playlistCss.includes(".action-toast"));
});

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[1];
}
