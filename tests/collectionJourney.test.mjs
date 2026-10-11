import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { build } from "esbuild";

await build({ stdin: { contents: `export { CollectionView } from './src/views/CollectionView';
export { useNavigation } from './src/hooks/useNavigation'; export { usePlaylists } from './src/hooks/usePlaylists';
export { InfoPanel } from './src/components/InfoPanel'; export { ContextMenu } from './src/components/ContextMenu';
export { SmartPlaylistDialog } from './src/components/SmartPlaylistDialog'; export { useModalFocus } from './src/hooks/useModalFocus';
export * from './src/utils/collectionEntities';`, resolveDir: process.cwd(), loader: "tsx" },
  outfile: ".tmp/collection-journey-tests.js", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const dom = new JSDOM('<body><button id="outside">外部</button><div id="root"></div></body>', { pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "KeyboardEvent", "MouseEvent", "FocusEvent", "getComputedStyle"]) globalThis[key] = dom.window[key];
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
window.__TAURI_INTERNALS__ = { convertFileSrc: path => path };
HTMLElement.prototype.scrollIntoView = function () {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { CollectionView, useNavigation, usePlaylists, InfoPanel, ContextMenu, SmartPlaylistDialog, useModalFocus, buildCollectionIndex, artistReference } = await import("../.tmp/collection-journey-tests.js");
const h = React.createElement;
const tracks = [
  { id: "a", title: "白日梦蓝", artist: "刺猬", album: "白日梦蓝", duration_seconds: 200 },
  { id: "b", title: "生之响往", artist: "刺猬", album: "生之响往", duration_seconds: 280 },
  { id: "c", title: "我要如何不想他", artist: "蔡琴", album: "不悔" },
  { id: "d", title: "同专辑第二曲", artist: "刺猬", album: "白日梦蓝", disc_number: 2, track_number: 1 },
].map(t => ({ path: t.id, file_name: `${t.id}.flac`, extension: "flac", ...t }));
const index = buildCollectionIndex(tracks);
const initialPlaylists = [{ id: "favorites", name: "喜欢的歌曲", trackIds: ["c", "a", "b"] },
  { id: "manual", name: "通勤", kind: "manual", trackIds: ["d", "b", "a"] }];
let api, playlistApi, contexts, played;
const nothing = () => {};
function Harness() {
  const [dialog, setDialog] = React.useState(null), [smartDialog, setSmartDialog] = React.useState(null);
  api = useNavigation({ contextMenu: null, infoTarget: null, addToPlaylistTarget: null, playlistDialog: dialog,
    smartPlaylistDialog: smartDialog, nowPlayingTargetsRef: React.useRef({ activeTrack: tracks[0], activePodcastEpisode: null }) });
  playlistApi = usePlaylists({ showActionNotice: nothing, tracks, restored: false, navigateCollection: api.navigateCollection,
    playbackQueueIds: ["b", "a"], activePodcastEpisode: null, activeTrack: tracks[0], setSelectedPlaylistId: api.setSelectedPlaylistId,
    playlistDialog: dialog, setPlaylistDialog: setDialog, smartPlaylistDialog: smartDialog, setSmartPlaylistDialog: setSmartDialog });
  React.useEffect(() => { playlistApi.setPlaylists(initialPlaylists); api.navigateCollection("playlists"); }, []);
  return api.page === "collection" ? h(CollectionView, {
    navigation: api.collection, view: api.view, index, queueIds: ["b", "a"], activeTrackId: "b",
    onOpen: api.openCollectionEntity, onTravel: api.travelCollection, searchInputRef: api.searchInputRef,
    onQuery: api.setCollectionSearchQuery, onClearSearch: api.clearCollectionSearch, onAddFolder: nothing, isScanning: false, scanNote: "",
    onPlay: (...args) => played.push(args), onPlayTracks: items => played.push(items), onContextMenu: (_, payload) => contexts.push(payload),
    playlists: playlistApi.playlists, selectedPlaylistId: api.selectedPlaylistId, onSelectPlaylist: api.setSelectedPlaylistId,
    onCreatePlaylist: playlistApi.openCreatePlaylistDialog, onEditSmartPlaylist: playlistApi.openSmartPlaylistEditor,
    onRefreshSmartPlaylist: playlistApi.refreshSmartPlaylist, trackActivity: {}, favoriteTrackIds: playlistApi.favoriteTrackIds,
    onToggleFavorite: playlistApi.toggleFavoriteTrack, onAddToQueue: nothing, onInfo: nothing, onAddToPlaylist: nothing,
    onReorderPlaylist: playlistApi.reorderPlaylist,
  }) : h("button", { "data-collection-focus": "external-artist", onClick: () => api.openCollectionEntity(artistReference(index.artistsByName.get("刺猬"))) }, "查看刺猬");
}
async function mount(t, element = h(Harness)) {
  contexts = []; played = [];
  document.getElementById("outside").focus();
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(h(React.StrictMode, null, element)));
  await act(async () => new Promise(resolve => setTimeout(resolve, 95)));
  t.after(async () => { await act(async () => root.unmount()); });
  return root;
}
async function click(element, detail = 1, type = "click") {
  assert.ok(element, "interaction target exists");
  await act(async () => { element.focus(); element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, detail })); });
}
async function key(element, key, modifiers = {}) {
  await act(async () => element.dispatchEvent(new KeyboardEvent("keydown", { key, ...modifiers, bubbles: true, cancelable: true })));
}
const byText = (selector, text) => [...document.querySelectorAll(selector)].find(node => node.textContent === text);
const heading = () => document.querySelector(".collection-entity-heading h1")?.textContent;

test("playlist → song → album → artist → another album returns focus and selection without playing", async t => {
  await mount(t);
  const rows = document.querySelectorAll(".collection-track-main");
  await click(rows[1]);
  const area = document.querySelector(".collection-track-scroll"); area.scrollTop = 58;
  await click(document.querySelector('[aria-label="查看歌曲 白日梦蓝"]'));
  assert.equal(heading(), "白日梦蓝");
  await click(byText(".collection-related-album a", "白日梦蓝"));
  assert.equal(document.querySelectorAll(".collection-disc-label").length, 2);
  await click(byText(".collection-entity-artist a", "刺猬"));
  assert.equal(heading(), "刺猬");
  assert.equal(document.querySelectorAll(".collection-album-select").length, 2);
  await click([...document.querySelectorAll(".collection-album-select")].find(node => node.textContent.includes("生之响往")));
  assert.equal(heading(), "生之响往");
  for (const label of ["返回刺猬", "返回白日梦蓝", "返回白日梦蓝", "返回喜欢的歌曲"]) {
    const back = document.querySelector(".collection-back");
    assert.equal(back.getAttribute("aria-label"), label);
    assert.equal(document.querySelector('[aria-label="前进"]'), null);
    await click(back);
  }
  assert.equal(api.view, "playlists");
  assert.deepEqual([...document.querySelectorAll(".collection-categories button")].map(node => node.textContent), ["艺术家", "流派", "专辑", "歌曲", "播放列表"]);
  assert.equal(document.querySelector(".collection-back"), null);
  assert.equal(document.activeElement.getAttribute("aria-label"), "查看歌曲 白日梦蓝");
  assert.equal(document.querySelector('[data-collection-selection]').dataset.collectionSelection, "a");
  assert.equal(document.querySelector(".collection-track-scroll").scrollTop, 58);
  await key(window, "ArrowRight", { altKey: true });
  assert.equal(heading(), "白日梦蓝");
  assert.equal(document.querySelector('[aria-label="前进"]'), null);
  await act(async () => document.querySelector(".collection-connected").dispatchEvent(new MouseEvent("auxclick", { button: 3, bubbles: true, cancelable: true })));
  assert.equal(document.activeElement.getAttribute("aria-label"), "查看歌曲 白日梦蓝");
  assert.equal(document.querySelector(".collection-track-scroll").scrollTop, 58);
  await act(async () => document.querySelector(".collection-connected").dispatchEvent(new MouseEvent("auxclick", { button: 4, bubbles: true, cancelable: true })));
  assert.equal(heading(), "白日梦蓝");
  await key(window, "ArrowLeft", { altKey: true });
  await act(async () => api.setSelectedPlaylistId("now"));
  await click(document.querySelector('[aria-label="查看歌曲 白日梦蓝"]'));
  assert.equal(document.querySelector(".collection-back").textContent, "返回正在播放");
  await click(document.querySelector(".collection-back"));
  assert.equal(api.selectedPlaylistId, "now");
  assert.deepEqual(played, []);
});
test("search filters, query and row focus survive related-object browsing", async t => {
  await mount(t);
  await act(async () => api.setCollectionSearchQuery("刺猬"));
  await click([...document.querySelectorAll(".search-filter button")].find(node => node.textContent.startsWith("歌曲")));
  await click(document.querySelector('[aria-label="查看歌曲 生之响往"]'));
  assert.equal(heading(), "生之响往");
  assert.equal(document.querySelector(".collection-back").textContent, "返回搜索结果");
  await click(document.querySelector(".collection-back"));
  assert.equal(document.querySelector("input").value, "刺猬");
  assert.equal(api.collection.location.filter, "songs");
  assert.equal(document.activeElement.getAttribute("aria-label"), "查看歌曲 生之响往");
  assert.equal(document.querySelector('[aria-label="前进"]'), null);
  assert.deepEqual(played, []);
});
test("external detail entry returns to its real page and focused source", async t => {
  await mount(t);
  await act(async () => api.requestNavigation("nowPlaying"));
  await act(async () => new Promise(resolve => setTimeout(resolve, 95)));
  await click(byText("button", "查看刺猬"));
  await act(async () => new Promise(resolve => setTimeout(resolve, 95)));
  assert.equal(heading(), "刺猬");
  assert.ok(document.querySelector(".collection-back").textContent.includes("正在播放"));
  await key(window, "ArrowLeft", { altKey: true });
  await act(async () => new Promise(resolve => setTimeout(resolve, 95)));
  assert.equal(api.page, "nowPlaying");
  assert.equal(document.activeElement.dataset.collectionFocus, "external-artist");
});
test("empty supplemental relationships disappear and exact relationship menus do not use the song scope", async t => {
  await mount(t);
  await act(async () => api.openCollectionEntity({ kind: "album", key: index.albumByTrackId.get("c").key, anchorTrackId: "c" }));
  assert.equal(heading(), "不悔");
  assert.ok(!document.querySelector(".collection-entity-scroll").textContent.includes("其他本地专辑"));
  await key(byText(".collection-entity-artist a", "蔡琴"), "F10", { shiftKey: true });
  assert.equal(contexts.at(-1).kind, "artist");
  assert.equal(contexts.at(-1).title, "蔡琴");
  assert.deepEqual(played, []);
});
test("manual reorder, removal, create-and-add and queue save keep other playlists and playback intact", async t => {
  await mount(t);
  await act(async () => api.setSelectedPlaylistId("manual"));
  const row = document.querySelectorAll(".collection-track-main")[1]; row.focus();
  await key(row, "ArrowUp", { altKey: true });
  assert.deepEqual(playlistApi.playlists.find(p => p.id === "manual").trackIds, ["b", "d", "a"]);
  assert.equal(document.activeElement, row);
  await act(async () => playlistApi.removeFromPlaylist("manual", [tracks[3]]));
  assert.deepEqual(playlistApi.playlists.find(p => p.id === "manual").trackIds, ["b", "a"]);
  assert.deepEqual(playlistApi.playlists.find(p => p.id === "favorites").trackIds, ["c", "a", "b"]);
  await act(async () => playlistApi.createPlaylistWithTracks("新的列表", [tracks[0], tracks[0], tracks[1]]));
  assert.deepEqual(playlistApi.playlists.find(p => p.name === "新的列表").trackIds, ["a", "b"]);
  await act(async () => playlistApi.saveQueueAsPlaylist("队列快照"));
  assert.deepEqual(playlistApi.playlists.find(p => p.name === "队列快照").trackIds, ["b", "a"]);
  assert.equal(api.selectedPlaylistId, "manual"); assert.deepEqual(played, []);
});

test("playlist keyboard choices and column sorting preserve stored positions, detail history and the queue", async t => {
  await mount(t);
  const indexButton = () => document.querySelector('.playlist-list > button[aria-pressed="true"]');
  await key(indexButton(), "End");
  assert.equal(api.selectedPlaylistId, "manual");
  assert.equal(document.activeElement, indexButton());
  const original = [...playlistApi.playlists.find(p => p.id === "manual").trackIds];
  const sortField = field => document.querySelector('.collection-sort[data-sort-field="' + field + '"]');
  await click(document.querySelector('[data-collection-anchor="b"] .collection-track-main'));
  await click(sortField("duration"));
  assert.deepEqual([...document.querySelectorAll(".collection-track-row")].map(row => row.dataset.collectionAnchor), ["a", "b", "d"]);
  assert.deepEqual([...document.querySelectorAll(".collection-track-number")].map(node => node.textContent), ["03", "02", "01"]);
  assert.equal(document.querySelector('[data-collection-anchor="b"] .collection-track-main').getAttribute("aria-pressed"), "true");
  await key(document.querySelector('[data-collection-anchor="b"] .collection-track-main'), "ArrowUp", { altKey: true });
  assert.deepEqual(playlistApi.playlists.find(p => p.id === "manual").trackIds, original, "display sorting cannot reorder the saved playlist");
  await click(document.querySelector('[aria-label="查看歌曲 生之响往"]'));
  await click(document.querySelector(".collection-back"));
  assert.equal(api.collection.location.browser.playlistSort.manual.field, "duration");
  assert.equal(document.activeElement.getAttribute("aria-label"), "查看歌曲 生之响往");
  await click(sortField("position"));
  assert.deepEqual([...document.querySelectorAll(".collection-track-row")].map(row => row.dataset.collectionAnchor), original);
  await key(indexButton(), "Home");
  assert.equal(api.selectedPlaylistId, "now");
  assert.deepEqual([...document.querySelectorAll(".collection-track-row")].map(row => row.dataset.collectionAnchor), ["b", "a"]);
  await key(indexButton(), "ArrowDown");
  assert.equal(api.selectedPlaylistId, "favorites");
  assert.deepEqual(played, []);
  await key(indexButton(), "End");
  await click(sortField("duration"));
  await click(byText(".playlist-header-actions button", "播放全部"));
  assert.deepEqual(played.map(source => source.map(track => track.id)), [["a", "b", "d"]], "explicit playback receives the displayed order as a snapshot");
  assert.deepEqual(playlistApi.playlists.find(p => p.id === "manual").trackIds, original);
});
test("metadata switches scope immediately and ignores late responses from another object", async t => {
  const pending = [];
  const metadata = { getContext: payload => new Promise(resolve => pending.push({ title: payload.title, resolve })) };
  const payload = artist => ({ kind: "artist", title: artist, targetId: artist, tracks: tracks.filter(track => track.artist === artist) });
  const root = await mount(t, h(InfoPanel, { payload: payload("刺猬"), metadata, onClose: nothing }));
  await act(async () => root.render(h(InfoPanel, { payload: payload("蔡琴"), metadata, onClose: nothing })));
  await act(async () => { for (const request of pending.filter(p => p.title === "刺猬")) request.resolve({ providerName: "旧对象来源", fields: [{ key: "biography", label: "简介", value: "过时资料" }] }); });
  assert.ok(!document.body.textContent.includes("过时资料"));
  assert.equal(document.querySelector("h2").textContent, "蔡琴");
  assert.ok(!document.querySelector("dl").textContent.includes(".flac"));
  assert.ok(![...document.querySelectorAll("dt")].some(node => node.textContent === "专辑"));
  await act(async () => { pending.find(p => p.title === "蔡琴").resolve({ providerName: "当前来源", fields: [{ key: "biography", label: "简介", value: "当前艺术家资料" }] }); });
  assert.ok(document.body.textContent.includes("当前艺术家资料"));
});

test("manual pointer reordering commits inside, cancels outside or on Escape, and never plays", async t => {
  await mount(t);
  await act(async () => api.setSelectedPlaylistId("manual"));
  const area = document.querySelector(".collection-track-scroll");
  const box = (top, height) => ({ left: 0, right: 800, top, bottom: top + height, width: 800, height });
  area.getBoundingClientRect = () => box(0, 132);
  const rows = () => [...area.querySelectorAll(".collection-track-row")];
  function measure() { rows().forEach((row, i) => { row.getBoundingClientRect = () => box(i * 44, 44); }); }
  async function pointer(target, type, y) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: y });
    Object.defineProperty(event, "pointerId", { value: 1 });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    await act(async () => target.dispatchEvent(event));
  }
  measure();
  await pointer(rows()[0].querySelector("button"), "pointerdown", 20);
  await pointer(area, "pointermove", 108);
  assert.ok(document.querySelector(".collection-track-drag-ghost"));
  await pointer(area, "pointerup", 108);
  assert.deepEqual(playlistApi.playlists.find(p => p.id === "manual").trackIds, ["b", "a", "d"]);
  assert.equal(document.querySelector(".collection-track-drag-ghost"), null);
  measure();
  await pointer(rows()[0].querySelector("button"), "pointerdown", 20);
  await pointer(area, "pointermove", 110);
  await pointer(area, "pointerup", 150);
  assert.deepEqual(playlistApi.playlists.find(p => p.id === "manual").trackIds, ["b", "a", "d"]);
  await pointer(rows()[0].querySelector("button"), "pointerdown", 20);
  await pointer(area, "pointermove", 110);
  await key(window, "Escape");
  assert.equal(document.querySelector(".collection-track-drag-ghost"), null);
  assert.deepEqual(playlistApi.playlists.find(p => p.id === "manual").trackIds, ["b", "a", "d"]);
  assert.deepEqual(played, []);
});
test("context menu exposes explicit object actions, keyboard traversal and safe playlist boundaries", async t => {
  const called = [];
  await mount(t, h(ContextMenu, { menu: { x: 12, y: 12, payload: { kind: "track", title: "白日梦蓝", tracks: [tracks[0]] } },
    onClose: nothing, onPlay: () => called.push("play"), onAddToQueue: nothing, onPlayNext: nothing, onStartSmartDj: nothing,
    onAddToPlaylist: nothing, onAddToFavorites: nothing, onRenamePlaylist: nothing, onDeletePlaylist: nothing,
    onExcludeFromSmartPlaylist: nothing, homePinState: null, onToggleHomePin: nothing, onInfo: nothing,
    onOpenInCollection: () => called.push("detail"), onOpenAlbum: nothing, onOpenArtist: nothing }));
  assert.ok(byText("button", "查看歌曲")); assert.ok(byText("button", "前往艺术家"));
  assert.ok(!byText("button", "从播放列表中移除"));
  assert.equal(document.activeElement.textContent, "播放");
  await key(document.activeElement, "End");
  assert.equal(document.activeElement.textContent, "前往专辑");
  await click(byText("button", "查看歌曲"));
  assert.deepEqual(called, ["detail"]);
});

test("smart editor handoff keeps background isolated and restores the original launcher", async t => {
  let setFirst, setSecond;
  function First() {
    const ref = React.useRef(null);
    useModalFocus(ref);
    return h("section", { ref, role: "dialog", "aria-modal": "true" }, h("button", { onClick: () => setSecond(true) }, "创建智能列表"));
  }
  function Handoff() {
    const [first, updateFirst] = React.useState(true), [second, updateSecond] = React.useState(false);
    setFirst = updateFirst; setSecond = updateSecond;
    return h(React.Fragment, null, first && h(First), second && h(SmartPlaylistDialog, {
      tracks, favoriteTrackIds: new Set(), activity: {}, onCancel: () => setSecond(false), onSave: nothing,
    }));
  }
  await mount(t, h(Handoff));
  await click(byText("button", "创建智能列表"));
  const editor = document.querySelector(".smart-playlist-dialog");
  assert.ok(editor.contains(document.activeElement));
  await act(async () => setFirst(false));
  assert.ok(document.getElementById("outside").hasAttribute("inert"));
  assert.ok(editor.contains(document.activeElement));
  const last = [...editor.querySelectorAll("button")].at(-1);
  last.focus(); await key(last, "Tab");
  assert.equal(document.activeElement, editor.querySelector("input"));
  await key(document.activeElement, "Escape");
  assert.equal(document.querySelector(".smart-playlist-dialog"), null);
  assert.equal(document.getElementById("outside").hasAttribute("inert"), false);
  assert.equal(document.activeElement, document.getElementById("outside"));
});
