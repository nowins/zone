import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { build } from "esbuild";

await build({ stdin: { contents: "export { CollectionView } from './src/views/CollectionView'; export { useCollectionNavigation } from './src/hooks/useCollectionNavigation'; export { buildCollectionIndex } from './src/utils/collectionEntities'; export { attachWheelScroll } from './src/motion/wheelScroll'; export { _setAnimationClockForTesting } from './src/motion/animate';",
  resolveDir: process.cwd(), loader: "tsx" }, outfile: ".tmp/collection-browser-runtime/view.mjs", bundle: true,
  packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const dom = new JSDOM('<body><div id="root"></div></body>', { pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "KeyboardEvent", "MouseEvent", "getComputedStyle"]) globalThis[key] = dom.window[key];
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
window.__TAURI_INTERNALS__ = { convertFileSrc: path => path };
HTMLElement.prototype.scrollIntoView = function () {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { CollectionView, useCollectionNavigation, buildCollectionIndex, attachWheelScroll, _setAnimationClockForTesting } = await import("../.tmp/collection-browser-runtime/view.mjs");
const h = React.createElement;
const tracks = [
  { id: "a", title: "Second", artist: "Coldplay", album: "Main", track_number: 2, duration_seconds: 30, genres: ["Rock"] },
  { id: "b", title: "First", artist: "Coldplay", album: "Main", track_number: 1, duration_seconds: 20, genres: ["Pop"] },
  { id: "c", title: "Other", artist: "Coldplay", album: "Side", duration_seconds: 10, genres: ["Jazz"] },
  { id: "d", title: "Third", artist: "Another", album: "Other", genres: ["Rock"] },
  { id: "e", title: "Unknown", artist: "Unknown", album: "Single" },
].map(track => ({ path: track.id, file_name: track.id + ".flac", extension: "flac", ...track }));
let navigation, played, contexts, replaceTracks, initialLibrary = tracks, commits = 0;
const noop = () => {};
function Harness() {
  navigation = useCollectionNavigation();
  const [library, setLibrary] = React.useState(initialLibrary);
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
async function mount(t, library = tracks) {
  initialLibrary = library;
  played = []; contexts = [];
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(h(React.StrictMode, null, h(React.Profiler, { id: "collection", onRender: () => commits++ }, h(Harness)))));
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
const album = name => [...document.querySelectorAll(".collection-album-select")].find(node => node.getAttribute("aria-label").startsWith(name + " ·"));
const sort = name => [...document.querySelectorAll(".collection-sort")].find(node => node.textContent === name);

test("artist and album selection keeps three panes, scroll and transport separate, with supplementary detail return", async t => {
  await mount(t, tracks.map(track => ({ ...track, cover_path: `cover-${track.id}.jpg` })));
  assert.equal(document.querySelector(".collection-band canvas"), null, "artwork remains in covers rather than a decorative collection layer");
  assert.ok(document.querySelector(".collection-album-select img"));
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
  assert.equal(document.querySelector(".collection-band canvas"), null);
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

test("spring writes, reverse jumps and fractional rows commit a filled viewport before painting", async t => {
  let height = 400, stride = 39.25, resize;
  globalThis.ResizeObserver = class { constructor(callback) { resize = callback; } observe() {} disconnect() {} };
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return this.matches(".collection-track-scroll") ? height : 0; } });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return this.matches(".collection-track-scroll") ? 300 * stride : 0; } });
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches(".collection-track-row")) return { ...originalRect.call(this), height: stride };
    return originalRect.call(this);
  };
  t.after(() => { delete globalThis.ResizeObserver; delete HTMLElement.prototype.clientHeight; delete HTMLElement.prototype.scrollHeight; HTMLElement.prototype.getBoundingClientRect = originalRect; });
  await mount(t, Array.from({ length: 300 }, (_, i) => ({ ...tracks[0], id: "scroll" + i, title: "Track " + i })));
  const area = document.querySelector(".collection-track-scroll");
  const filled = () => {
    const window = area.firstElementChild;
    const start = Number(window.firstElementChild.getAttribute("aria-posinset")) - 1;
    assert.equal(parseFloat(window.style.paddingTop), start * stride, "fractional row height is not rounded");
    assert.ok(start * stride <= area.scrollTop, "no blank above the rendered window");
    assert.ok((start + window.children.length) * stride >= area.scrollTop + height, "no blank below the rendered window");
  };
  await act(() => { area.scrollTop = 7000; area.dispatchEvent(new window.Event("scroll")); filled(); });
  const before = commits;
  await act(() => { area.scrollTop += 1; area.dispatchEvent(new window.Event("scroll")); });
  assert.equal(commits, before, "scrolling inside the same row window does not reconcile the list");
  let time = 0; const frames = [];
  _setAnimationClockForTesting(() => time, callback => frames.push(callback));
  const stop = attachWheelScroll(area.parentElement, ".collection-track-scroll"); t.after(stop);
  for (const deltaY of [-6000, 9000, -12000]) {
    area.dispatchEvent(new window.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }));
    for (let i = 0; i < 80; i++) await act(() => { time += 16; frames.splice(0).forEach(frame => frame(time)); filled(); });
  }
  await act(() => { height = 540; stride = 39.5; resize(); filled(); });
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

test("browse captions sort without leaving the selection scope or starting transport", async t => {
  await mount(t, [
    { ...tracks[0], track_number: 8, disc_number: 2, year: 2001 },
    { ...tracks[1], track_number: 0, disc_number: 1, year: 2001 },
    { ...tracks[2], year: 2020 }, tracks[4],
  ]);
  await click(choice("Coldplay"));
  assert.deepEqual([...document.querySelectorAll(".collection-album-select")].map(node => node.getAttribute("aria-label").split(" ·")[0]), ["Side", "Main"]);
  await click(album("Main"));
  assert.deepEqual(rows(), ["b", "a"]);
  assert.deepEqual([...document.querySelectorAll(".collection-track-number")].map(node => node.textContent), ["00", "08"]);
  const songSort = document.querySelector('[data-collection-focus="browse-song-sort:artists"]');
  await click(songSort); assert.equal(songSort.textContent, "喜欢优先");
  await click(songSort); assert.equal(songSort.textContent, "A–Z");
  assert.equal(album("Main").getAttribute("aria-pressed"), "true");
  assert.deepEqual(rows(), ["b", "a"]);
  await click(document.querySelector('[data-collection-focus="browse-album-sort:artists"]'));
  assert.equal(album("Main").getAttribute("aria-pressed"), "true");
  await click(document.querySelector('[aria-label="查看歌曲 Second"]'));
  await click(document.querySelector(".collection-back"));
  assert.equal(document.querySelector('[data-collection-focus="browse-song-sort:artists"]').textContent, "A–Z");
  assert.equal(album("Main").getAttribute("aria-pressed"), "true");
  await click(document.querySelector('[aria-label="全部专辑歌曲"]'));
  assert.equal(rows().length, 3);
  await click([...document.querySelectorAll(".collection-categories button")].find(node => node.textContent === "专辑"));
  assert.equal(album("Main").querySelector(":scope > span").textContent, "Coldplay，2001", "another category's artist selection must not hide album credits");
  assert.deepEqual(played, []);
});

test("large browsers mount a viewport, navigate the full source and restore offscreen detail focus", async t => {
  const observers = new Set();
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.add(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); observers.delete(this); }
  };
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return this.matches(".collection-track-scroll") ? 400 : 0; } });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return this.matches(".collection-track-row") ? this.closest(".is-compact") ? 39 : 45 : 0; } });
  t.after(() => { delete globalThis.IntersectionObserver; delete HTMLElement.prototype.clientHeight; delete HTMLElement.prototype.offsetHeight; });
  const library = Array.from({ length: 300 }, (_, i) => ({ ...tracks[0], id: "large" + i, path: "large" + i,
    title: "Track " + i, artist: "Artist " + String(i).padStart(3, "0"), album: "Album " + String(i).padStart(3, "0"), track_number: 1 }));
  await mount(t, library);
  assert.ok(document.querySelectorAll(".collection-browse-choice").length <= 64);
  assert.ok(document.querySelectorAll(".collection-album-select").length <= 48);
  assert.ok(rows().length < 30);
  assert.equal(document.querySelectorAll('[data-collection-window-item^="album:"]').length, 300, "empty anchors retain the complete grid geometry");
  await act(async () => {
    for (const observer of observers) observer.callback([...observer.targets].map((target, i) => ({ target, isIntersecting: i >= 100 && i < 110 })));
  });
  assert.equal(choice("Artist 100")?.textContent, "Artist 100", "scroll visibility mounts the newly visible names");
  assert.equal(choice("Artist 000")?.tabIndex, 0, "scrolling keeps the roving Tab entry available");
  assert.equal(album("Album 000")?.tabIndex, 0);
  await key(choice("Artist 100"), "End");
  assert.equal(document.activeElement.textContent, "Artist 299");
  assert.equal(choice("Artist 299").getAttribute("aria-pressed"), "true");
  assert.equal(rows().length, 1);
  await click(document.querySelector('[aria-label="全部艺术家"]'));
  await key(album("Album 000"), "End");
  assert.equal(document.activeElement, album("Album 299"));
  assert.deepEqual(rows(), ["large299"]);
  assert.deepEqual(played, [], "offscreen browsing never starts transport");
  await act(async () => navigation.openIndex("genres"));
  await key(album("Album 000"), "End");
  assert.equal(document.activeElement, album("Album 299"), "End crosses unmounted artist groups");
  await act(async () => navigation.openIndex("songs"));
  assert.equal(observers.size, 0, "leaving the browser releases both visibility observers");
  await key(document.querySelector(".collection-track-main"), "End");
  assert.equal(document.activeElement.title, "Track 299 · Artist 299 · Album 299");
  assert.ok(rows().length < 30);
  assert.equal(document.querySelector('[data-collection-anchor="large299"]').getAttribute("aria-posinset"), "300");
  const scrollTop = document.querySelector(".collection-track-scroll").scrollTop;
  assert.ok(scrollTop > 10000);
  await click(document.querySelector('[aria-label="查看歌曲 Track 299"]'));
  await click(document.querySelector(".collection-back"));
  assert.equal(document.querySelector(".collection-track-scroll").scrollTop, scrollTop);
  assert.equal(document.activeElement.getAttribute("aria-label"), "查看歌曲 Track 299");
  await click(document.querySelector('[data-collection-anchor="large299"] .collection-track-main'), 2, "dblclick");
  assert.equal(played[0][0], "large299");
  assert.equal(played[0][1].length, 300, "playback receives all sorted songs, not the mounted viewport");
  await click(sort("歌曲"));
  assert.equal(document.querySelector(".collection-track-scroll").scrollTop, 0);
  assert.equal(rows()[0], "large299");
  assert.equal(document.querySelector('[data-collection-anchor="large299"] .collection-track-main').getAttribute("aria-pressed"), "true");
  await key(document.querySelector(".collection-track-main"), "End");
  assert.equal(document.activeElement.title, "Track 0 · Artist 000 · Album 000");
  assert.equal(played.length, 1);
  await act(async () => replaceTracks(library.slice(0, 100)));
  assert.ok(rows().length > 0 && rows().length < 30, "shrinking a scrolled library retains a bounded, nonempty viewport");
  await act(async () => replaceTracks(library.slice(0, 79)));
  document.querySelector(".collection-track-scroll").scrollTop = 90;
  await act(async () => replaceTracks(library));
  assert.equal(document.querySelector(".collection-track-scroll").scrollTop, 90, "crossing the windowing threshold preserves current scrolling instead of replaying history");
});
