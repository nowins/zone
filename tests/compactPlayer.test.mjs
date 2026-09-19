import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";

// React detects input-event support once, when its DOM renderer is imported.
const bootstrap = new JSDOM('<!doctype html>');
globalThis.window = bootstrap.window;
globalThis.document = bootstrap.window.document;
const { createRoot } = await import("react-dom/client");
bootstrap.window.close();

await build({ entryPoints: ["src/views/CompactPlayerView.tsx", "src/components/Titlebar.tsx", "src/hooks/useCompactMode.ts", "src/utils/collectionEntities.ts"],
  outdir: ".tmp/compact-tests", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { CompactPlayerView } = await import("../.tmp/compact-tests/views/CompactPlayerView.js");
const { useCompactMode } = await import("../.tmp/compact-tests/hooks/useCompactMode.js");
const { Titlebar } = await import("../.tmp/compact-tests/components/Titlebar.js");
const { buildCollectionIndex } = await import("../.tmp/compact-tests/utils/collectionEntities.js");
const tracks = [1, 2, 3].map(i => ({ id: String(i), path: `${i}.mp3`, file_name: `${i}.mp3`, title: `歌曲 ${i}`,
  artist: "艺术家", album: "专辑", track_number: i, extension: "mp3", duration_seconds: 180 }));

function setup() {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  for (const name of ["window", "document", "HTMLElement", "Element", "HTMLInputElement"]) globalThis[name] = name === "window" ? dom.window : dom.window[name];
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById("root"));
  return { root, close: async () => { await act(() => root.unmount()); dom.window.close(); } };
}

async function viewFixture(overrides = {}) {
  const env = setup(), calls = [];
  const props = { index: buildCollectionIndex(tracks), playlists: [{ id: "list", name: "我的列表", trackIds: ["3", "1"] }], activity: {},
    favoriteTrackIds: new Set(["2"]), track: tracks[1], queueIds: ["3", "2", "1"], episode: null, podcastQueue: [], podcastStatus: "idle",
    playbackRate: 1, isPlaying: true, ready: true, progress: 30, duration: 180, volume: 0.5, shuffle: false, repeat: "off" };
  for (const name of ["onPlay", "onPlayTracks", "onToggleFavorite", "onPlayPause", "onPrevious", "onNext", "onSeek", "onVolume", "onShuffle", "onRepeat", "onPlaybackRate", "onToggleSaved", "onPlayEpisode", "onRetryPodcast", "onOpenNormal"])
    props[name] = (...args) => calls.push([name, ...args]);
  Object.assign(props, overrides);
  await act(() => env.root.render(React.createElement(React.StrictMode, null, React.createElement(CompactPlayerView, props))));
  return { ...env, calls, props };
}
const click = async selector => { const node = document.querySelector(selector); assert.ok(node, selector); await act(() => node.click()); };
const openScreen = async screen => {
  if (document.getElementById(`compact-tab-${screen}`)) return click(`#compact-tab-${screen}`);
  if (document.getElementById('compact-options-toggle').getAttribute('aria-expanded') !== 'true') await click('#compact-options-toggle');
  await click(`.compact-options-navigation button:${screen === 'music' ? 'first' : 'last'}-child`);
};
const pointer = async (node, type, x, y) => {
  const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  await act(() => node.dispatchEvent(event));
};

test("compact queue preserves source order and favorites do not change playback", async () => {
  const env = await viewFixture();
  try {
    await openScreen("queue");
    assert.deepEqual([...document.querySelectorAll(".compact-track strong")].map(node => node.textContent), ["歌曲 3", "歌曲 2", "歌曲 1"]);
    assert.match(document.querySelector('.compact-track[aria-current="true"]').textContent, /歌曲 2/);
    await click('.compact-track-row:last-child .compact-track');
    assert.equal(env.calls[0][1].id, "1");
    assert.deepEqual(env.calls[0][2].map(track => track.id), ["3", "2", "1"]);
    await click('.compact-track-row:first-child .compact-favorite');
    assert.equal(env.calls[1][0], "onToggleFavorite");
    assert.equal(env.calls.length, 2);
    await click('.compact-list-heading button');
    assert.deepEqual(env.calls[2], ["onOpenNormal", "collection"]);
  } finally { await env.close(); }
});

test("compact library browses without playing and resolves saved-list order", async () => {
  const env = await viewFixture();
  try {
    await openScreen("music");
    await click('.compact-categories button:last-child');
    await click('.compact-group');
    assert.equal(document.activeElement.textContent, "返回");
    assert.equal(env.calls.length, 0);
    assert.deepEqual([...document.querySelectorAll(".compact-track strong")].map(node => node.textContent), ["歌曲 3", "歌曲 1"]);
    await click('.compact-list-heading button');
    assert.deepEqual(env.calls[0][1].map(track => track.id), ["3", "1"]);
    await act(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(document.activeElement.dataset.compactItem, "list");
    assert.equal(document.querySelector(".compact-back"), null);
  } finally { await env.close(); }
});

test("compact playback stays quiet when paused and keeps secondary actions in options", async () => {
  const env = await viewFixture();
  try {
    assert.equal(document.querySelector('[role="tablist"]'), null);
    assert.equal(document.querySelector('.compact-album'), null);
    assert.equal(document.querySelector('.compact-now h1').textContent, '歌曲 2');
    assert.equal(document.querySelector('.compact-artist').textContent, '艺术家');
    assert.equal(document.querySelector('.compact-transport .compact-favorite'), null);
    assert.equal(document.querySelectorAll('.compact-transport button').length, 4);
    await click('[title="暂停"]');
    assert.deepEqual(env.calls.map(([name]) => name), ['onPlayPause']);
    await act(() => env.root.render(React.createElement(React.StrictMode, null, React.createElement(CompactPlayerView, { ...env.props, isPlaying: false }))));
    assert.equal(document.querySelector('[role="tablist"]'), null, 'pausing does not change the layout');
    assert.equal(document.querySelector('[title="播放"]').disabled, false);
    await click('#compact-options-toggle');
    await click('.compact-options [title="取消收藏"]');
    assert.equal(env.calls[1][0], 'onToggleFavorite');
    assert.equal(env.calls[1][1].id, '2');
    assert.equal(env.calls.length, 2);
    assert.equal(document.querySelector('audio'), null);
  } finally { await env.close(); }
});

test("compact browse tabs use arrow keys and returning to playback restores a visible focus target", async () => {
  const env = await viewFixture();
  try {
    await openScreen('music');
    const tab = document.getElementById("compact-tab-music");
    tab.focus();
    await act(() => tab.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    assert.equal(document.activeElement.id, "compact-tab-queue");
    assert.equal(document.activeElement.getAttribute("aria-selected"), "true");
    await act(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(document.activeElement.id, "compact-content");
    assert.equal(document.activeElement.getAttribute('aria-label'), '正在播放');
    assert.equal(document.querySelector('[role="tablist"]'), null);
    await openScreen('music');
    await act(() => document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
    assert.equal(document.activeElement.id, "compact-content");
    assert.equal(env.calls.length, 0);
  } finally { await env.close(); }
});

test("compact options preserve transport, focus volume and restore focus on Escape", async () => {
  const env = await viewFixture();
  try {
    assert.equal(document.querySelector('[aria-label="音量"]'), null);
    await click('#compact-options-toggle');
    await act(() => new Promise(resolve => setTimeout(resolve, 30)));
    assert.equal(document.activeElement.getAttribute("aria-label"), "音量");
    assert.equal(document.querySelector('[title="暂停"]').disabled, false);
    await click('[title="随机播放"]');
    await click('[title="关闭循环"]');
    assert.deepEqual(env.calls.map(([name]) => name), ["onShuffle", "onRepeat"]);
    await act(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(document.activeElement.id, "compact-options-toggle");
    assert.equal(document.activeElement.getAttribute("aria-expanded"), "false");
    assert.equal(document.getElementById("compact-options").hasAttribute("inert"), true);
    await click('#compact-options-toggle');
    await pointer(document.getElementById('compact-content'), 'pointerdown', 110, 45);
    await act(() => new Promise(resolve => setTimeout(resolve, 30)));
    assert.equal(document.getElementById("compact-options-toggle").getAttribute("aria-expanded"), "false");
    await openScreen('music');
    assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').id, "compact-tab-music");
  } finally { await env.close(); }
});

test("horizontal gestures switch pivots and go back without activating a dragged item", async () => {
  const env = await viewFixture();
  try {
    const content = document.getElementById('compact-content');
    content.setPointerCapture = () => {};
    async function swipe(node, from, to) {
      await pointer(node, 'pointerdown', ...from);
      await pointer(node, 'pointermove', ...to);
      await pointer(node, 'pointerup', ...to);
      await act(() => node.dispatchEvent(new window.MouseEvent('click', { detail: 1, bubbles: true, cancelable: true })));
    }
    await swipe(content, [180, 130], [40, 135]);
    assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').id, 'compact-tab-music');
    const album = document.querySelector('.compact-group');
    await swipe(album, [40, 135], [160, 140]);
    assert.ok(document.querySelector('.compact-player.is-focused'));
    assert.equal(env.calls.length, 0);
    await openScreen('music');
    await click('.compact-group');
    await swipe(document.querySelector('.compact-track'), [40, 135], [160, 140]);
    assert.equal(document.querySelector('.compact-back'), null);
    assert.ok(document.activeElement.dataset.compactItem);
    assert.equal(env.calls.length, 0, 'a drag over a song never starts playback');
    await swipe(content, [100, 100], [110, 190]);
    assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').id, 'compact-tab-music', 'vertical scrolling keeps the pivot');
    await swipe(document.querySelector('input'), [180, 100], [40, 100]);
    assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').id, 'compact-tab-music', 'text selection is not a navigation gesture');
    await pointer(content, 'pointerdown', 180, 130);
    await pointer(content, 'pointermove', 40, 135);
    await pointer(content, 'pointercancel', 40, 135);
    await pointer(content, 'pointerup', 40, 135);
    assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').id, 'compact-tab-music');
  } finally { await env.close(); }
});

test("podcast seek, save, rate and queue stay separate from music actions", async () => {
  const episode = { id: "pod", episodeId: "pod", title: "当前单集", podcastTitle: "节目", saved: false };
  const env = await viewFixture({ episode, podcastQueue: [{ episode: { id: "next", title: "下一单集", feedTitle: "节目" }, position: 0 }], progress: 5, duration: 22 });
  try {
    assert.equal(document.querySelector('[title="随机播放"]'), null);
    await click('[title="后退 15 秒"]');
    await click('[title="前进 30 秒"]');
    await click('[title="更多播放选项"]');
    await click('[title="稍后听"]');
    await click('[title="播放速度"]');
    await openScreen('queue');
    await click('.compact-episode:last-of-type');
    assert.deepEqual(env.calls, [["onSeek", 0], ["onSeek", 22], ["onToggleSaved"], ["onPlaybackRate", 1.25], ["onPlayEpisode", "next"]]);
  } finally { await env.close(); }
});

test("empty library offers normal-mode import and disables transport", async () => {
  const env = await viewFixture({ index: buildCollectionIndex([]), track: null, playlists: [], isPlaying: false });
  try {
    assert.equal(document.querySelector('[title="播放"]').disabled, true);
    assert.equal(document.querySelector('[aria-label="播放进度"]').disabled, true);
    const button = [...document.querySelectorAll("button")].find(node => node.textContent === "在正常模式添加音乐");
    await act(() => button.click());
    assert.deepEqual(env.calls, [["onOpenNormal", "settings"]]);
    assert.equal(document.querySelector("audio"), null, "the surface never creates a second audio element");
  } finally { await env.close(); }
});

async function modeFixture(invoke) {
  const env = setup(); let mode;
  globalThis.isTauri = true;
  window.__TAURI_INTERNALS__ = { invoke };
  function Fixture() { mode = useCompactMode(); return null; }
  await act(() => env.root.render(React.createElement(React.StrictMode, null, React.createElement(Fixture))));
  return { ...env, mode: () => mode };
}

test("native mode hydrates after reload and serializes repeated clicks", async () => {
  let finish; const commands = [];
  const env = await modeFixture(async (command, args) => {
    if (command === "get_compact_mode") return { active: true, pinned: true };
    commands.push(args.compact);
    return await new Promise(resolve => { finish = () => resolve({ active: args.compact, pinned: false }); });
  });
  try {
    assert.equal(env.mode().active, true);
    assert.equal(env.mode().pinned, true, "reload reads the native pin state");
    await act(() => { void env.mode().setCompact(false); void env.mode().setCompact(false); });
    assert.equal(env.mode().pending, true);
    assert.equal(env.mode().active, true, "keep current surface while native mutation is pending");
    assert.deepEqual(commands, [false]);
    await act(async () => finish());
    assert.equal(env.mode().active, false);
    assert.equal(env.mode().pinned, false, "returning to normal mode clears the compact pin indicator");
    assert.equal(env.mode().pending, false);
  } finally { await env.close(); }
});

test("failed native transition remains retryable and keeps current mode", async () => {
  let fail = true;
  const env = await modeFixture(async (command, args) => {
    if (command === "get_compact_mode") return { active: false, pinned: false };
    if (fail) throw new Error("window unavailable");
    return { active: args.compact, pinned: false };
  });
  try {
    await act(() => env.mode().setCompact(true));
    assert.equal(env.mode().active, false);
    assert.equal(env.mode().pending, false);
    assert.match(env.mode().error, /无法进入小屏/);
    fail = false;
    await act(() => env.mode().setCompact(true));
    assert.equal(env.mode().active, true);
    assert.equal(env.mode().error, null);
  } finally { await env.close(); }
});

test("pinning and mode changes share a lock and normal mode cannot pin", async () => {
  let finish; const commands = [];
  const env = await modeFixture(async (command, args) => {
    if (command === "get_compact_mode") return { active: true, pinned: false };
    commands.push([command, args]);
    return await new Promise(resolve => {
      finish = () => resolve(command === "set_compact_pinned"
        ? { active: true, pinned: args.pinned } : { active: args.compact, pinned: false });
    });
  });
  try {
    await act(() => {
      void env.mode().setPinned(true);
      void env.mode().setPinned(true);
      void env.mode().setCompact(false);
    });
    assert.equal(env.mode().pending, true);
    assert.equal(env.mode().pinned, false, "do not claim success before native confirmation");
    assert.deepEqual(commands, [["set_compact_pinned", { pinned: true }]]);
    await act(async () => finish());
    assert.equal(env.mode().pinned, true);
    await act(() => { void env.mode().setCompact(false); void env.mode().setPinned(false); });
    assert.equal(commands.length, 2);
    await act(async () => finish());
    assert.equal(env.mode().active, false);
    assert.equal(env.mode().pinned, false);
    await act(() => env.mode().setPinned(true));
    assert.equal(commands.length, 2, "normal mode never sends a pin command");
  } finally { await env.close(); }
});

test("pin failure reconciles actual native status and permits a retry", async () => {
  let pinned = false, fail = true;
  const env = await modeFixture(async (command, args) => {
    if (command === "get_compact_mode") return { active: true, pinned };
    pinned = args.pinned;
    if (fail) throw new Error("native status read failed after applying pin");
    return { active: true, pinned };
  });
  try {
    await act(() => env.mode().setPinned(true));
    assert.equal(env.mode().active, true);
    assert.equal(env.mode().pinned, true, "failed IPC is reconciled with the actual native flag");
    assert.equal(env.mode().pending, false);
    assert.match(env.mode().error, /无法置顶窗口/);
    fail = false;
    await act(() => env.mode().setPinned(false));
    assert.equal(env.mode().pinned, false);
    assert.equal(env.mode().error, null);
  } finally { await env.close(); }
});

test("titlebar exposes a compact-only pin toggle with native status and pending feedback", async () => {
  const env = setup(); let clicks = 0;
  window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" } } };
  const props = { isSettings: false, onOpenSettings() {}, showSettings: false, compact: true,
    onToggleCompact() {}, onTogglePinned() { clicks++; } };
  const render = patch => act(() => env.root.render(React.createElement(Titlebar, { ...props, ...patch })));
  try {
    await render({ pinned: false });
    const pin = document.querySelector('[aria-label="置顶窗口"]');
    assert.equal(pin.getAttribute("aria-pressed"), "false");
    assert.equal(pin.nextElementSibling.title, "返回正常模式");
    await click('[aria-label="置顶窗口"]');
    assert.equal(clicks, 1);
    await render({ pinned: true, modePending: true });
    assert.equal(pin.getAttribute("aria-pressed"), "true");
    assert.equal(pin.title, "取消置顶");
    await click('[aria-label="置顶窗口"]');
    assert.equal(clicks, 1, "pending native requests cannot be repeated");
    assert.equal(document.querySelector('.titlebar-mode').disabled, true);
    await render({ compact: false, pinned: true });
    assert.equal(document.querySelector('.titlebar-pin'), null);
  } finally { await env.close(); }
});
