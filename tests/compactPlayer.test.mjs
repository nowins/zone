import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

await build({ entryPoints: ["src/views/CompactPlayerView.tsx", "src/hooks/useCompactMode.ts", "src/utils/collectionEntities.ts"],
  outdir: ".tmp/compact-tests", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { CompactPlayerView } = await import("../.tmp/compact-tests/views/CompactPlayerView.js");
const { useCompactMode } = await import("../.tmp/compact-tests/hooks/useCompactMode.js");
const { buildCollectionIndex } = await import("../.tmp/compact-tests/utils/collectionEntities.js");
const tracks = [1, 2, 3].map(i => ({ id: String(i), path: `${i}.mp3`, file_name: `${i}.mp3`, title: `歌曲 ${i}`,
  artist: "艺术家", album: "专辑", track_number: i, extension: "mp3", duration_seconds: 180 }));

function setup() {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  for (const name of ["window", "document", "HTMLElement", "Element", "HTMLInputElement"]) globalThis[name] = name === "window" ? dom.window : dom.window[name];
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
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

test("compact queue preserves source order and favorites do not change playback", async () => {
  const env = await viewFixture();
  try {
    await click("#compact-tab-queue");
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
    await click("#compact-tab-music");
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

test("compact tabs use arrow keys and Escape restores the now-playing tab focus", async () => {
  const env = await viewFixture();
  try {
    const tab = document.getElementById("compact-tab-now");
    tab.focus();
    await act(() => tab.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    assert.equal(document.activeElement.id, "compact-tab-music");
    assert.equal(document.activeElement.getAttribute("aria-selected"), "true");
    await act(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(document.activeElement.id, "compact-tab-now");
    assert.equal(env.calls.length, 0);
  } finally { await env.close(); }
});

test("podcast seek, save, rate and queue stay separate from music actions", async () => {
  const episode = { id: "pod", episodeId: "pod", title: "当前单集", podcastTitle: "节目", saved: false };
  const env = await viewFixture({ episode, podcastQueue: [{ episode: { id: "next", title: "下一单集", feedTitle: "节目" }, position: 0 }], progress: 5, duration: 22 });
  try {
    assert.equal(document.querySelector('[title="随机播放"]'), null);
    await click('[title="后退 15 秒"]');
    await click('[title="前进 30 秒"]');
    await click('[title="稍后听"]');
    await click('[title="播放速度"]');
    await click('#compact-tab-queue');
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
    if (command === "get_compact_mode") return true;
    commands.push(args.compact);
    return await new Promise(resolve => { finish = () => resolve(args.compact); });
  });
  try {
    assert.equal(env.mode().active, true);
    await act(() => { void env.mode().setCompact(false); void env.mode().setCompact(false); });
    assert.equal(env.mode().pending, true);
    assert.equal(env.mode().active, true, "keep current surface while native mutation is pending");
    assert.deepEqual(commands, [false]);
    await act(async () => finish());
    assert.equal(env.mode().active, false);
    assert.equal(env.mode().pending, false);
  } finally { await env.close(); }
});

test("failed native transition remains retryable and keeps current mode", async () => {
  let fail = true;
  const env = await modeFixture(async (command, args) => {
    if (command === "get_compact_mode") return false;
    if (fail) throw new Error("window unavailable");
    return args.compact;
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
