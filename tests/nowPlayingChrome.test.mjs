import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";

// Let React detect modern input events against a DOM before it is imported.
const bootstrap = new JSDOM('<body></body>');
globalThis.window = bootstrap.window;
globalThis.document = bootstrap.window.document;
const { createRoot } = await import("react-dom/client");
bootstrap.window.close();

// Isolate media/network leaves while exercising the real view, queue and controls.
const leaves = {
  NowPlayingMosaicCanvas: `import React, {useEffect} from 'react'; export function NowPlayingMosaicCanvas({onInitialRevealStart}) { useEffect(onInitialRevealStart, [onInitialRevealStart]); return React.createElement('canvas'); }`,
  AudioGlowCanvas: "export function AudioGlowCanvas() { return null; }",
  Cover: `import React from 'react'; export function Cover() { return React.createElement('div', {className:'mini-cover'}); }`,
  LyricsStage: "export function LyricsStage() { return null; }",
  useLyrics: "export function useLyrics() { return {}; }",
  useNowPlayingFullscreen: "export function useNowPlayingFullscreen() { return {active:false, pending:false, toggle(){}}; }",
};
await build({ entryPoints: ["src/views/NowPlayingView.tsx"], outfile: ".tmp/now-chrome-tests/view.js",
  bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent",
  plugins: [{ name: "media-leaves", setup(build) {
    build.onResolve({ filter: /\/(NowPlayingMosaicCanvas|AudioGlowCanvas|Cover|LyricsStage|useLyrics|useNowPlayingFullscreen)$/ }, args => ({ path: args.path.split("/").at(-1), namespace: "media-leaf" }));
    build.onLoad({ filter: /.*/, namespace: "media-leaf" }, args => ({ contents: leaves[args.path], resolveDir: process.cwd() }));
  } }],
});
const { NowPlayingView } = await import("../.tmp/now-chrome-tests/view.js");
const tracks = Array.from({ length: 14 }, (_, i) => ({ id: String(i), title: `歌曲 ${i + 1}`, artist: `艺术家 ${i + 1}`, album: "专辑", path: String(i), duration: 300 }));

async function fixture() {
  const dom = new JSDOM('<body><div id="root"></div></body>', { pretendToBeVisual: true });
  for (const key of ["window", "document", "HTMLElement", "Element", "Node"]) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let time = 0, nextId = 0, hidden = false;
  const timers = new Map();
  const errors = [];
  window.addEventListener("error", event => errors.push(event.error));
  window.setTimeout = (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: time + delay }); return id; };
  window.clearTimeout = id => timers.delete(id);
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(document, "hidden", { get: () => hidden });
  const root = createRoot(document.getElementById("root"));
  const noop = () => {};
  const played = [];
  let props = { track: tracks[0], tracks, queue: tracks, isPlaying: true, playbackClock: () => 10,
    progress: 10, duration: 300, shuffle: false, repeat: "off", isFavorite: false, volume: 0.5,
    onBack: noop, onPlay: track => played.push(track.id), onPlayPause: noop, onToggleFavorite: noop,
    onPrevious: noop, onNext: noop, onSeek: noop, onShuffle: noop, onRepeat: noop, onVolume: noop, onSaveQueueAsPlaylist: noop };
  const render = async patch => { props = { ...props, ...patch }; await act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(NowPlayingView, props)))); };
  const advance = async ms => act(() => {
    const end = time + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= end);
      if (!next) break;
      time = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    time = end;
  });
  const event = async (element, type, data = {}) => act(() => element.dispatchEvent(
    type === "keydown" ? new window.KeyboardEvent(type, { bubbles: true, ...data }) : new window.MouseEvent(type, { bubbles: true, ...data })));
  const stage = () => document.querySelector(".now-playing-stage");
  const isIdle = () => stage().classList.contains("chrome-immersive");
  await render({});
  await advance(1250);
  return { render, advance, event, stage, isIdle, played,
    async visibility(value) { hidden = value; await act(() => document.dispatchEvent(new window.Event("visibilitychange"))); },
    async close() { await act(() => root.unmount()); assert.equal(timers.size, 0, "unmount clears idle and entrance timers"); assert.deepEqual(errors, []); dom.window.close(); },
  };
}

test("idle chrome becomes inert, wakes from document keys and preserves the mounted queue", async () => {
  const env = await fixture();
  try {
    const panel = document.querySelector(".now-side-panel");
    const list = panel.querySelector(".now-panel-tracks");
    list.scrollTop = 120;
    await env.advance(4999); assert.equal(env.isIdle(), false);
    await env.advance(1); assert.equal(env.isIdle(), true);
    for (const selector of [".now-back", ".now-side-panel", ".now-transport"]) assert.equal(document.querySelector(selector).hasAttribute("inert"), true);
    await env.event(document.body, "keydown", { key: "Tab" });
    assert.equal(env.isIdle(), false);
    assert.equal(document.querySelector(".now-side-panel"), panel, "waking must not remount or replay the panel entrance");
    assert.equal(list.scrollTop, 120);
    assert.equal(panel.hasAttribute("inert"), false);
    const rows = [...panel.querySelectorAll(".now-panel-upcoming button")];
    assert.deepEqual(rows.map(row => row.querySelector("strong").textContent), tracks.map(track => track.title));
    await env.event(rows[6], "click"); assert.deepEqual(env.played, ["6"]);
    await env.render({ track: tracks[6] });
    assert.equal(rows[6].getAttribute("aria-current"), "true");
    await env.advance(5000); assert.equal(env.isIdle(), true);
    await env.event(env.stage(), "mousemove"); assert.equal(env.isIdle(), false);
  } finally { await env.close(); }
});

test("pause, held pointers, keyboard focus and the save dialog keep controls available", async () => {
  const env = await fixture();
  try {
    await env.render({ isPlaying: false }); await env.advance(20000); assert.equal(env.isIdle(), false);
    await env.render({ isPlaying: true });
    await env.event(document.querySelector('.zune-volume input'), "pointerdown");
    await env.advance(12000); assert.equal(env.isIdle(), false, "a held slider must not disappear");
    await env.event(window, "pointerup");
    await env.advance(4999); assert.equal(env.isIdle(), false);
    await env.event(document.querySelector(".save-queue"), "click");
    await env.advance(20000); assert.equal(env.isIdle(), false);
    assert.ok(document.querySelector('[role="dialog"]'));
    await env.event(document.querySelector('.dialog-actions button[type="button"]'), "click");
    const back = document.querySelector(".now-back");
    await act(() => back.focus());
    await env.advance(10000); assert.equal(env.isIdle(), false, "keyboard focus survives the idle deadline");
    await act(() => back.blur());
    await env.advance(5000); assert.equal(env.isIdle(), true);
    await env.render({ isPlaying: false }); assert.equal(env.isIdle(), false, "external pause reveals controls immediately");
  } finally { await env.close(); }
});

test("visibility suspends the countdown and waking preserves an explicitly hidden queue", async () => {
  const env = await fixture();
  try {
    await env.advance(4000);
    await env.visibility(true); await env.advance(20000); assert.equal(env.isIdle(), false);
    await env.visibility(false); await env.advance(4999); assert.equal(env.isIdle(), false);
    await env.advance(1); assert.equal(env.isIdle(), true);
    await env.event(document.body, "keydown", { key: "Shift" });
    const toggle = document.querySelector('[title="隐藏正在播放列表"]');
    assert.ok(toggle);
    await env.event(toggle, "click");
    const exiting = document.querySelector(".now-side-panel");
    assert.equal(exiting.hasAttribute("inert"), true);
    assert.equal(exiting.getAttribute("aria-hidden"), "true");
    await env.advance(5000); await env.event(env.stage(), "mousemove");
    assert.ok(document.querySelector('[title="显示正在播放列表"]'));
    assert.ok(!document.querySelector('.now-side-panel[aria-hidden="false"]'));
  } finally { await env.close(); }
});
