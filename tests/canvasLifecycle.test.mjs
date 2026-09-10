import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

// Bundle the actual components so their browser-style imports also run in Node.
await build({ entryPoints: ["src/components/AudioGlowCanvas.tsx", "src/components/NowPlayingMosaicCanvas.tsx"],
  outdir: ".tmp/canvas-tests", bundle: true, packages: "external", format: "esm", platform: "browser",
  define: { "import.meta.env.DEV": "false" }, logLevel: "silent" });
const { AudioGlowCanvas } = await import("../.tmp/canvas-tests/AudioGlowCanvas.js");
const { NowPlayingMosaicCanvas } = await import("../.tmp/canvas-tests/NowPlayingMosaicCanvas.js");

test("actual Canvas effects survive StrictMode, sleep when static and wake for changes", async () => {
  const dom = new JSDOM('<body><div id="root"></div></body>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const frames = new Map();
  let nextId = 0;
  let now = performance.now();
  let hidden = false;
  let resize;
  const mediaListeners = new Set();
  const media = { matches: false, addEventListener: (_event, listener) => mediaListeners.add(listener),
    removeEventListener: (_event, listener) => mediaListeners.delete(listener) };
  window.matchMedia = () => media;
  Object.defineProperty(document, "hidden", { get: () => hidden });
  Object.defineProperty(document, "visibilityState", { get: () => hidden ? "hidden" : "visible" });
  window.requestAnimationFrame = callback => { frames.set(++nextId, callback); return nextId; };
  window.cancelAnimationFrame = id => frames.delete(id);
  // Zero-size layout bypasses rasterization, keeping this a lifecycle test.
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  globalThis.ResizeObserver = class { constructor(callback) { resize = callback; } observe() {} disconnect() {} };
  const root = createRoot(document.getElementById("root"));
  const tracks = [];
  const render = async (playing, volume = 0.5) => act(async () => root.render(React.createElement(React.StrictMode, null,
    React.createElement(AudioGlowCanvas, { isPlaying: playing, volume }),
    React.createElement(NowPlayingMosaicCanvas, { isPlaying: playing, tracks, activeTrack: null }))));
  const step = (ms = 16) => { now += ms; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now)); };
  try {
    await render(false);
    assert.equal(frames.size, 2, "StrictMode replay restarts both loops");
    step(2000);
    assert.equal(frames.size, 0, "paused canvases stop");
    await render(true);
    step(2000);
    assert.equal(frames.size, 2, "playing keeps both canvases live");
    await render(true, 0);
    step(2000);
    assert.equal(frames.size, 1, "muted glow sleeps while the artwork remains active");
    await render(true);
    step(2000);
    assert.equal(frames.size, 2, "unmuting wakes the glow");
    hidden = true; document.dispatchEvent(new window.Event("visibilitychange"));
    assert.equal(frames.size, 0, "background cancels pending frames");
    hidden = false; document.dispatchEvent(new window.Event("visibilitychange"));
    assert.equal(frames.size, 2);
    await act(async () => { media.matches = true; mediaListeners.forEach(listener => listener()); });
    step(2000);
    assert.equal(frames.size, 0, "reduced motion reaches a static frame even while playing");
    resize();
    assert.equal(frames.size, 1, "a resize wakes its Canvas");
    step(2000);
    assert.equal(frames.size, 0);
  } finally {
    await act(async () => root.unmount());
    assert.equal(frames.size, 0);
    assert.equal(mediaListeners.size, 0);
    dom.window.close();
  }
});
