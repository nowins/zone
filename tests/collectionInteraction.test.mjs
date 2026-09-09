import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { build } from "esbuild";

await build({ entryPoints: ["src/components/CollectionTrackList.tsx", "src/components/CollectionAlbumTile.tsx", "src/views/LibraryView.tsx"],
  outdir: ".tmp/collection-tests", outbase: "src", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { CollectionTrackList } = await import("../.tmp/collection-tests/components/CollectionTrackList.js");
const { CollectionAlbumTile } = await import("../.tmp/collection-tests/components/CollectionAlbumTile.js");
const { LibraryView } = await import("../.tmp/collection-tests/views/LibraryView.js");
const dom = new JSDOM('<body><div id="root"></div></body>');
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "KeyboardEvent", "MouseEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = function () {};
const h = React.createElement;
const { buildCollectionIndex } = await import("../.tmp/visualizer-tests/utils/collectionEntities.js");
const tracks = [
  { id: "a", title: "白日梦蓝", artist: "刺猬", album: "白日梦蓝", duration_seconds: 200 },
  { id: "b", title: "我要如何不想他", artist: "蔡琴", album: "不悔", duration_seconds: null },
  { id: "c", title: "很长的歌曲名称用于验证完整提示", artist: "刺猬", album: "白日梦蓝", duration_seconds: 295 },
].map((track, index) => ({ ...track, file_name: `${index + 1}.mp3`, path: `${index + 1}.mp3`, extension: "mp3" }));
async function mount(t, element) {
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(h(React.StrictMode, null, element)));
  t.after(async () => { await act(async () => root.unmount()); });
  return root;
}
async function click(element, detail = 1, type = "click") {
  await act(async () => element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, detail })));
}
const mainRows = () => [...document.querySelectorAll(".collection-track-main")];

test("collection rows separate selection, playback and favorite actions", async t => {
  const played = [], favorites = [];
  await mount(t, h(CollectionTrackList, { tracks, activeTrackId: "a", onPlay: (...args) => played.push(args),
    onContextMenu() {}, favoriteTrackIds: new Set(["a"]), onToggleFavorite: track => favorites.push(track.id) }));
  await click(mainRows()[1]);
  assert.equal(played.length, 0);
  assert.equal(mainRows()[1].getAttribute("aria-pressed"), "true");
  assert.equal(mainRows()[0].getAttribute("aria-current"), "true");
  assert.equal(mainRows()[1].getAttribute("aria-current"), null);
  await click(mainRows()[1], 2, "dblclick");
  assert.deepEqual(played, [[tracks[1], tracks]]);
  await click(mainRows()[2], 0);
  assert.deepEqual(played[1], [tracks[2], tracks]);
  await click(document.querySelector(".collection-track-favorite"));
  assert.deepEqual(favorites, ["a"]);
  assert.equal(played.length, 2);
  assert.equal(document.querySelectorAll(".collection-track-duration")[0].textContent, "3:20");
  assert.equal(document.querySelectorAll(".collection-track-duration")[1].textContent, "—");
  assert.ok(mainRows()[2].title.includes(tracks[2].title));
});

test("arrow and boundary keys move focus without starting playback", async t => {
  let played = 0;
  await mount(t, h(CollectionTrackList, { tracks, activeTrackId: null, onPlay: () => played++, onContextMenu() {} }));
  mainRows()[0].focus();
  for (const [key, expected] of [["ArrowDown", 1], ["End", 2], ["ArrowDown", 2], ["Home", 0], ["ArrowUp", 0]]) {
    await act(async () => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    assert.equal(document.activeElement, mainRows()[expected]);
    assert.equal(document.activeElement.getAttribute("aria-pressed"), "true");
  }
  assert.equal(played, 0);
});

test("album tiles expose independent keyboard selection and playback buttons", async t => {
  let selected = 0, played = 0;
  await mount(t, h(CollectionAlbumTile, { name: "专辑", artist: "艺术家", index: 0, selected: false,
    onSelect: () => selected++, onPlay: () => played++, onContextMenu() {} }));
  await click(document.querySelector(".collection-album-select"), 0);
  assert.equal(selected, 1); assert.equal(played, 0);
  await click(document.querySelector(".album-play"), 0);
  assert.equal(played, 1); assert.equal(selected, 1);
  assert.equal(document.querySelector("button button"), null);
});

test("all collection views keep their own playback source and right-click context", async t => {
  const played = [], contexts = [];
  const albumTracks = [tracks[0], tracks[2]];
  const props = {
    index: buildCollectionIndex(tracks), tracks, libraryTracks: tracks, albums: [{ key: "album", album: "白日梦蓝", artist: "刺猬", tracks: albumTracks }],
    artists: [{ artist: "刺猬", tracks: albumTracks }], queueIds: ["b", "a"], activeTrackId: "b",
    selectedAlbumKey: "album", selectedArtistName: "刺猬", selectedPlaylistId: "now",
    playlists: [], trackActivity: {}, favoriteTrackIds: new Set(),
    onOpen() {}, onSelectAlbum() {}, onSelectPlaylist() {}, onCreatePlaylist() {}, onEditSmartPlaylist() {}, onRefreshSmartPlaylist() {}, onToggleFavorite() {},
    onPlay: (...args) => played.push(args), onPlayTracks() {}, onContextMenu: (_, payload) => contexts.push(payload),
  };
  const root = await mount(t, null);
  for (const [view, expected] of [["songs", tracks], ["playlists", [tracks[1], tracks[0]]]]) {
    await act(async () => root.render(h(React.StrictMode, null, h(LibraryView, { ...props, key: view, view }))));
    const before = played.length;
    await click(mainRows()[0]);
    assert.equal(played.length, before, view);
    await click(mainRows()[0], 0);
    assert.deepEqual(played.at(-1), [expected[0], expected], view);
    await click(mainRows()[0], 1, "contextmenu");
    assert.deepEqual(contexts.at(-1).playbackTracks, expected, view);
    if (view === "playlists") assert.equal(contexts.at(-1).playlistId, "now");
  }
});

test("an empty queue retains its heading, with a disabled play action and no fabricated duration", async t => {
  await mount(t, h(LibraryView, { view: "playlists", index: buildCollectionIndex([]), playlists: [], queueIds: [],
    selectedPlaylistId: "now", activeTrackId: null, favoriteTrackIds: new Set(), trackActivity: {},
    onPlay() {}, onPlayTracks() {}, onContextMenu() {}, onToggleFavorite() {}, onCreatePlaylist() {} }));
  assert.equal(document.querySelector(".playlist-heading h2").textContent, "正在播放");
  assert.equal(document.querySelector(".playlist-header-actions button").disabled, true);
  assert.equal(mainRows().length, 0);
  assert.equal(document.querySelector(".collection-empty").textContent, "暂无歌曲");
  assert.ok(!document.querySelector(".playlist-heading").textContent.includes("分钟"));
});

test("smart playlist header actions retain the selected rules and resolved playback source", async t => {
  const edited = [], refreshed = [], played = [];
  const playlist = { id: "smart", name: "刺猬精选", kind: "smart", description: "我的规则", excludedTrackIds: [],
    smart: { match: "all", rules: [{ id: "artist", field: "artist", operator: "equals", value: "刺猬" }],
      order: "title", limitKind: "tracks", limitValue: 20, maxPerArtist: 20, maxPerAlbum: 20,
      preferFavorites: false, avoidSkipped: false, rotateDaily: false, rotationSeed: 0 } };
  await mount(t, h(LibraryView, { view: "playlists", index: buildCollectionIndex(tracks), playlists: [playlist], queueIds: [],
    selectedPlaylistId: "smart", activeTrackId: null, favoriteTrackIds: new Set(), trackActivity: {},
    onPlay() {}, onPlayTracks: items => played.push(items), onContextMenu() {}, onToggleFavorite() {}, onCreatePlaylist() {},
    onEditSmartPlaylist: id => edited.push(id), onRefreshSmartPlaylist: id => refreshed.push(id) }));
  const [play, edit, refresh] = document.querySelectorAll(".playlist-header-actions button");
  await click(play); await click(edit); await click(refresh);
  assert.equal(played.length, 1);
  assert.deepEqual(new Set(played[0].map(track => track.id)), new Set(["a", "c"]));
  assert.deepEqual(edited, ["smart"]);
  assert.deepEqual(refreshed, ["smart"]);
  assert.match(document.querySelector(".playlist-heading").textContent, /2 首歌曲 · 9 分钟/);
});
