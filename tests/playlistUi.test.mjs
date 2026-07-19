import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync("src/App.tsx", "utf8");
const menuSource = readFileSync("src/components/ContextMenu.tsx", "utf8");
const browserSource = readFileSync("src/views/PlaylistBrowser.tsx", "utf8");
const dialogSource = readFileSync("src/components/PlaylistDialog.tsx", "utf8");
const collectionCss = readFileSync("src/styles/collection.css", "utf8");
const playlistCss = readFileSync("src/styles/playlists.css", "utf8");

test("playlist page presents one total and localized labels", () => {
  assert.ok(!browserSource.includes("playlists.length} playlists"));
  assert.ok(browserSource.includes("新建播放列表"));
  assert.ok(browserSource.includes("当前队列"));
  assert.ok(browserSource.includes("首歌曲"));
  assert.ok(!collectionCss.includes(".playlist-list p"));
});

test("playlist context actions do not offer favorites or self nesting", () => {
  assert.ok(menuSource.includes('!isPlaylist && ('));
  assert.ok(menuSource.includes("playlist.id !== sourcePlaylistId"));
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
  assert.ok(dialogSource.includes("aria-modal=\"true\""));
  assert.ok(dialogSource.includes("不会从音乐库中删除"));
  assert.ok(appSource.includes("showActionNotice"));
  assert.ok(appSource.includes("openPlaylistDialog"));
  assert.ok(playlistCss.includes(".playlist-dialog-overlay"));
  assert.ok(playlistCss.includes(".action-toast"));
});

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[1];
}
