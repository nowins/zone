import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
// Initialize React's input support detection against an actual DOM.
const bootstrap = new JSDOM('<!doctype html>');
globalThis.window = bootstrap.window;
globalThis.document = bootstrap.window.document;
const { createRoot } = await import("react-dom/client");
bootstrap.window.close();

await build({ entryPoints: ["src/components/TransportControls.tsx", "src/hooks/useNowPlayingFullscreen.ts"],
  outdir: ".tmp/transport-controls-tests", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { TransportControls, VolumeControl } = await import("../.tmp/transport-controls-tests/components/TransportControls.js");
const { useNowPlayingFullscreen } = await import("../.tmp/transport-controls-tests/hooks/useNowPlayingFullscreen.js");

function setup() {
  const dom = new JSDOM('<div id="root"></div>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  for (const key of ["Element", "HTMLElement", "Node"]) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById("root"));
  return { root, close: async () => { await act(() => root.unmount()); dom.window.close(); } };
}

test("repeat renders distinct off, list and single-track states without changing playback actions", async () => {
  const env = setup();
  let plays = 0;
  let repeats = 0;
  const noop = () => {};
  try {
    for (const [repeat, title] of [["off", "关闭循环"], ["all", "列表循环"], ["one", "单曲循环"]]) {
      await act(() => env.root.render(React.createElement(TransportControls, {
        trackAvailable: true, isPlaying: false, shuffle: false, repeat,
        onQueue: noop, onLyrics: noop, onFullscreen: noop, onRepeat: () => repeats++, onShuffle: noop,
        onPrevious: noop, onPlayPause: () => plays++, onNext: noop,
      })));
      const button = document.querySelector(`[title="${title}"]`);
      assert.equal(button.getAttribute("aria-pressed"), String(repeat !== "off"));
      assert.equal(Boolean(button.querySelector(".lucide-repeat1")), repeat === "one");
      await act(() => button.click());
      await act(() => document.querySelector('[title="播放"]').click());
      assert.ok(document.querySelector('[title="显示正在播放列表"]'));
    }
    assert.equal(plays, 3);
    assert.equal(repeats, 3);
  } finally { await env.close(); }
});

test("volume wheel handles bursts, direction, fine deltas and limits without scrolling the page", async () => {
  const env = setup();
  const values = [];
  let outerScrolls = 0;
  window.addEventListener("wheel", () => outerScrolls++);
  try {
    await act(() => env.root.render(React.createElement(VolumeControl, { volume: 0.8, onVolume: v => values.push(v) })));
    const label = document.querySelector(".zune-volume");
    const wheel = (deltaY, extra = {}) => {
      const event = new window.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true, ...extra });
      label.dispatchEvent(event);
      return event;
    };
    assert.equal(wheel(-100).defaultPrevented, true);
    wheel(-100);
    assert.ok(Math.abs(values.at(-1) - 0.9) < 1e-8, "bursts use the latest value before React rerenders");
    for (let i = 0; i < 8; i++) wheel(-100);
    assert.equal(values.at(-1), 1);
    for (let i = 0; i < 24; i++) wheel(100);
    assert.equal(values.at(-1), 0);
    wheel(-10);
    assert.ok(Math.abs(values.at(-1) - 0.005) < 1e-8);
    assert.equal(outerScrolls, 0);
    const before = values.length;
    assert.equal(wheel(-100, { ctrlKey: true }).defaultPrevented, false);
    wheel(0);
    assert.equal(values.length, before);
    await act(() => env.root.render(React.createElement(VolumeControl, { volume: 0.5, onVolume: v => values.push(v) })));
    wheel(3, { deltaMode: 1 });
    assert.equal(values.at(-1), 0.45, "external volume updates and line-mode mouse wheels are respected");
  } finally { await env.close(); }
});

test("volume opens by click, restores focus on Escape and leaves outside focus alone", async () => {
  const env = setup();
  const values = [];
  try {
    await act(() => env.root.render(React.createElement(React.StrictMode, null,
      React.createElement(VolumeControl, { volume: 0.5, onVolume: value => values.push(value) }))));
    const trigger = document.querySelector('.zune-volume-toggle');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(() => trigger.click());
    const panel = document.querySelector('[role="dialog"]');
    const slider = panel.querySelector('input');
    assert.equal(trigger.getAttribute('aria-controls'), panel.id);
    assert.equal(document.activeElement, slider);
    assert.equal(slider.getAttribute('aria-valuetext'), '50%');
    assert.equal(values.length, 0, 'opening volume must not change it');
    const wheel = new window.WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    await act(() => slider.dispatchEvent(wheel));
    assert.equal(wheel.defaultPrevented, true);
    assert.equal(values.at(-1), 0.55, 'the detached popup keeps wheel volume control');
    let escaped = false;
    window.addEventListener('keydown', () => { escaped = true; });
    await act(() => slider.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, trigger);
    assert.equal(panel.hasAttribute('inert'), true);
    assert.equal(escaped, false);
    await act(() => trigger.click());
    assert.equal(document.activeElement, panel.querySelector('input'));
    const outside = document.createElement('button');
    document.body.append(outside);
    await act(() => outside.focus());
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, outside);
    await act(() => trigger.click());
    await act(() => outside.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })));
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    outside.remove();
  } finally { await env.close(); }
  assert.equal(document.querySelector('.volume-popover'), null);
});

test("inline volume stays directly available without a second popover", async () => {
  const env = setup();
  try {
    await act(() => env.root.render(React.createElement(VolumeControl, { volume: 0.3, onVolume() {}, inline: true })));
    assert.ok(document.querySelector('.zune-volume.is-inline input'));
    assert.equal(document.querySelector('.zune-volume-toggle'), null);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { await env.close(); }
});

async function fullscreenFixture(invoke) {
  const env = setup();
  let state;
  window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" } }, invoke };
  function Fixture() { state = useNowPlayingFullscreen(); return null; }
  await act(() => env.root.render(React.createElement(React.StrictMode, null, React.createElement(Fixture))));
  return { ...env, state: () => state };
}

test("fullscreen enters, Escape exits first, and leaving the surface restores the window", async () => {
  const mutations = [];
  const env = await fullscreenFixture(async (command, args) => {
    if (command.endsWith("is_fullscreen")) return false;
    mutations.push(args.value);
  });
  let bubbled = false;
  window.addEventListener("keydown", () => { bubbled = true; });
  try {
    await act(() => env.state().toggle());
    assert.equal(env.state().active, true);
    const escape = new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    await act(() => window.dispatchEvent(escape));
    assert.equal(env.state().active, false);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(bubbled, false, "Escape must not also close lyrics or dialogs");
    await act(() => env.state().toggle());
  } finally { await env.close(); }
  assert.deepEqual(mutations, [true, false, true, false]);
});

test("Escape during pending fullscreen entry is serialized after entry", async () => {
  const mutations = [];
  let finishEntry;
  const env = await fullscreenFixture(async (command, args) => {
    if (command.endsWith("is_fullscreen")) return false;
    mutations.push(args.value);
    if (args.value) await new Promise(resolve => { finishEntry = resolve; });
  });
  try {
    await act(() => env.state().toggle());
    assert.equal(env.state().pending, true);
    await act(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" })));
    await act(async () => { finishEntry(); });
    assert.deepEqual(mutations, [true, false]);
    assert.equal(env.state().active, false);
    assert.equal(env.state().pending, false);
  } finally { await env.close(); }
});

test("failed fullscreen requests stay retryable and do not claim fullscreen", async () => {
  let fail = true;
  const env = await fullscreenFixture(async command => {
    if (command.endsWith("is_fullscreen")) return false;
    if (fail) throw new Error("denied");
  });
  try {
    await act(() => env.state().toggle());
    assert.equal(env.state().active, false);
    assert.equal(env.state().pending, false);
    assert.ok(env.state().error);
    fail = false;
    await act(() => env.state().toggle());
    assert.equal(env.state().active, true);
    assert.equal(env.state().error, null);
  } finally { await env.close(); }
});

test("unmount during pending entry still restores the native window", async () => {
  const mutations = [];
  let finishEntry;
  const env = await fullscreenFixture(async (command, args) => {
    if (command.endsWith("is_fullscreen")) return false;
    mutations.push(args.value);
    if (args.value) await new Promise(resolve => { finishEntry = resolve; });
  });
  await act(() => env.state().toggle());
  await env.close();
  await act(async () => { finishEntry(); });
  assert.deepEqual(mutations, [true, false]);
});
