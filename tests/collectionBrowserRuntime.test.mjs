import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { build } from "esbuild";

await build({ stdin: { contents: "export { CollectionView } from './src/views/CollectionView'; export { useCollectionNavigation } from './src/hooks/useCollectionNavigation'; export { buildCollectionIndex } from './src/utils/collectionEntities';",
  resolveDir: process.cwd(), loader: "tsx" }, outfile: ".tmp/collection-browser-runtime/view.mjs", bundle: true,
  packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const dom = new JSDOM('<body><div id="root"></div></body>', { pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "KeyboardEvent", "MouseEvent", "getComputedStyle"]) globalThis[key] = dom.window[key];
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
window.__TAURI_INTERNALS__ = { convertFileSrc: path => path };
HTMLElement.prototype.scrollIntoView = function () {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { CollectionView, useCollectionNavigation, buildCollectionIndex } = await import("../.tmp/collection-browser-runtime/view.mjs");
const h = React.createElement;
const tracks = [
  { id: "a", title: "Second", artist: "Coldplay", album: "Main", track_number: 2, duration_seconds: 30, genres: ["Rock"] },
  { id: "b", title: "First", artist: "Coldplay", album: "Main", track_number: 1, duration_seconds: 20, genres: ["Pop"] },
  { id: "c", title: "Other", artist: "Coldplay", album: "Side", duration_seconds: 10, genres: ["Jazz"] },
  { id: "d", title: "Third", artist: "Another", album: "Other", genres: ["Rock"] },
  { id: "e", title: "Unknown", artist: "Unknown", album: "Single" },
].map(track => ({ path: track.id, file_name: track.id + ".flac", extension: "flac", ...track }));
let navigation, played, contexts, replaceTracks;
const noop = () => {};
function Harness() {
  navigation = useCollectionNavigation();
  const [library, setLibrary] = React.useState(tracks);
  replaceTracks = setLibrary;
  const index = React.useMemo(() => buildCollectionIndex(library), [library]);
  return h(CollectionView, {
    navigation, index, view: navigation.location.view, queueIds: ["a"], activeTrackId: "a",
    onOpen: navigation.open, onTravel: navigation.travel, searchInputRef: React.useRef(null),
    onQuery: navigation.setQuery, onClearSearch: () => navigation.setQuery(""), onAddFolder: noop, isScanning: false, scanNote: "",
    onPlay: (track, source) => played.push([track.id, source.map(item => item.id)]),
    onPlayTracks: items => played.push(items.map(item => item.id)), onContextMenu: (_, payload) => contexts.push(payload),
    playlists: [], selectedPlaylistId: "favorites", onSelectPlaylist: navigation.setPlaylistId,
    onCreatePlaylist: noop, onEditSmartPlaylist: noop, onRefreshSmartPlaylist: noop,
    trackActivity: {}, favoriteTrackIds: new Set(), onToggleFavorite: noop, onAddToQueue: noop, onInfo: noop, onAddToPlaylist: noop,
  });
}
async function mount(t) {
  played = []; contexts = [];
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(h(React.StrictMode, null, h(Harness))));
  t.after(async () => act(async () => root.unmount()));
}
async function click(node, detail = 1, type = "click") {
  assert.ok(node, "interaction target exists");
  await act(async () => { node.focus(); node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, detail })); });
}
async function key(node, key) {
  await act(async () => node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}
const rows = () => [...document.querySelectorAll(".collection-track-row")].map(node => node.dataset.collectionAnchor);
const choice = name => [...document.querySelectorAll(".collection-browse-choice")].find(node => node.textContent === name);
const album = name => [...document.querySelectorAll(".collection-album-select")].find(node => node.title.startsWith(name + " ·"));
const sort = name => [...document.querySelectorAll(".collection-sort")].find(node => node.textContent === name);

test("artist and album selection keeps three panes, scroll and transport separate, with supplementary detail return", async t => {
  await mount(t);
  assert.equal(document.querySelectorAll(".collection-browse-pane").length, 3);
  assert.equal(document.querySelectorAll(".collection-browse-choice[aria-pressed=true]").length, 0);
  assert.equal(rows().length, 5);
  const left = document.querySelector('[data-collection-scroll="browse-index:artists"]');
  left.scrollTop = 73;
  await click(choice("Coldplay"));
  assert.equal(document.querySelector('[data-collection-scroll="browse-index:artists"]'), left);
  assert.equal(left.scrollTop, 73);
  assert.equal(document.querySelectorAll(".collection-album-select").length, 2);
  assert.deepEqual(rows(), ["b", "c", "a"]);
  await click(album("Main"));
  assert.deepEqual(rows(), ["b", "a"]);
  const albums = document.querySelector('[data-collection-scroll="browse-albums:artists"]'); albums.scrollTop = 19;
  const right = document.querySelector(".collection-track-scroll"); right.scrollTop = 38;
  await click(document.querySelector('[aria-label="查看歌曲 Second"]'));
  assert.equal(document.querySelector(".collection-entity-heading h1").textContent, "Second");
  await click(document.querySelector(".collection-back"));
  assert.equal(choice("Coldplay").getAttribute("aria-pressed"), "true");
  assert.equal(album("Main").getAttribute("aria-pressed"), "true");
  assert.equal(document.querySelector('[data-collection-scroll="browse-index:artists"]').scrollTop, 73);
  assert.equal(document.querySelector('[data-collection-scroll="browse-albums:artists"]').scrollTop, 19);
  assert.equal(document.querySelector(".collection-track-scroll").scrollTop, 38);
  assert.equal(document.activeElement.getAttribute("aria-label"), "查看歌曲 Second");
  await click(document.querySelector('[aria-label="查看艺术家 Coldplay"]'));
  assert.equal(document.querySelector(".collection-entity-heading h1").textContent, "Coldplay");
  await click(document.querySelector(".collection-back"));
  await click(document.querySelector('[aria-label="全部专辑歌曲"]'));
  assert.equal(rows().length, 3);
  await key(choice("Coldplay"), "ArrowDown");
  assert.equal(document.activeElement.textContent, "Unknown");
  assert.equal(choice("Unknown").getAttribute("aria-pressed"), "true");
  assert.deepEqual(played, []);
});

test("albums use two panes and genres group album artists while respecting song tags", async t => {
  await mount(t);
  await act(async () => navigation.openIndex("albums"));
  assert.equal(document.querySelectorAll(".collection-browse-pane").length, 2);
  assert.equal(rows().length, 5);
  await click(album("Main"), 0);
  assert.deepEqual(rows(), ["b", "a"]);
  assert.deepEqual(played, []);
  await act(async () => navigation.openIndex("genres"));
  assert.equal(document.querySelectorAll(".collection-browse-pane").length, 3);
  assert.equal(document.querySelectorAll(".collection-browse-album-group").length, 3);
  assert.equal(document.querySelector('.collection-album-select[tabindex="0"]'), album("Other"), "Tab enters the first visible artist group");
  await click(choice("Rock"));
  assert.deepEqual([...document.querySelectorAll(".collection-browse-album-group h3")].map(node => node.textContent), ["Another", "Coldplay"]);
  assert.deepEqual(rows(), ["a", "d"]);
  await click(album("Main"));
  assert.deepEqual(rows(), ["a"]);
  await click(album("Other").parentElement.querySelector(".album-play"));
  assert.deepEqual(played, [["d"]], "explicit album playback uses that album's genre scope, not the selected album");
  assert.deepEqual(rows(), ["a"]);
  await click(document.querySelector('[aria-label="全部流派"]'));
  assert.equal(rows().length, 5);
  await key(album("Other"), "End");
  assert.equal(document.activeElement, album("Single"), "album keyboard browsing crosses artist groups");
  assert.deepEqual(rows(), ["e"]);
  assert.deepEqual(played, [["d"]]);
});

test("column sorting preserves identity and detail return and never rewrites a submitted playback source", async t => {
  await mount(t);
  await act(async () => navigation.openIndex("songs"));
  assert.deepEqual(rows(), ["b", "c", "a", "d", "e"]);
  await click(document.querySelectorAll(".collection-track-main")[2]);
  await click(sort("时长"));
  assert.deepEqual(rows(), ["c", "b", "a", "d", "e"]);
  assert.equal(document.querySelector('[data-collection-anchor="a"] .collection-track-main').getAttribute("aria-pressed"), "true");
  assert.equal(document.querySelector('[data-collection-anchor="a"] .collection-track-main').getAttribute("aria-current"), "true");
  await click(sort("时长"));
  assert.deepEqual(rows(), ["a", "b", "c", "d", "e"]);
  await click(document.querySelector(".collection-track-main"), 2, "dblclick");
  const snapshot = ["a", ["a", "b", "c", "d", "e"]];
  assert.deepEqual(played, [snapshot]);
  await click(sort("艺术家"));
  assert.deepEqual(played, [snapshot]);
  document.querySelector(".collection-track-scroll").scrollTop = 66;
  await click(document.querySelector('[aria-label="查看歌曲 Second"]'));
  await click(document.querySelector(".collection-back"));
  assert.equal(navigation.location.browser.songSort.field, "artist");
  assert.equal(document.querySelector(".collection-track-scroll").scrollTop, 66);
  assert.equal(document.activeElement.getAttribute("aria-label"), "查看歌曲 Second");
  await click(document.querySelector(".collection-genre-toggle"));
  assert.equal(document.querySelectorAll(".collection-track-genre").length, 5);
  await click(sort("流派"));
  assert.equal(navigation.location.browser.songSort.field, "genre");
  await click(document.querySelector(".collection-genre-toggle"));
  assert.equal(navigation.location.browser.songSort.field, "title");
  assert.equal(document.querySelectorAll(".collection-track-genre").length, 0);
  assert.deepEqual(played, [snapshot]);
});

test("a removed selection shows unavailable content and clearing it reveals the remaining library", async t => {
  await mount(t);
  await click(choice("Coldplay"));
  await click(album("Main"));
  await act(async () => replaceTracks([tracks[4]]));
  assert.equal(rows().length, 0);
  assert.ok(document.querySelector(".collection-browse").textContent.includes("所选内容已不可用"));
  assert.equal(document.querySelectorAll(".collection-browse-choice[aria-pressed=true]").length, 0);
  await click(document.querySelector('[aria-label="全部艺术家"]'));
  assert.deepEqual(rows(), ["e"]);
  assert.deepEqual(played, []);
});
