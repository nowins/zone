import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

await build({ stdin: { contents: `export { AudioGlowCanvas } from './src/components/AudioGlowCanvas';
  export { publishVisualizerFrame } from './src/utils/visualizerBus';`, resolveDir: process.cwd(), loader: "ts" },
  outfile: ".tmp/spectrum-glow-tests/runtime.mjs", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { AudioGlowCanvas, publishVisualizerFrame } = await import("../.tmp/spectrum-glow-tests/runtime.mjs");

test("actual Canvas draws two overlapping layers from live bands and releases on pause/mute/reduced motion", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(document, "hidden", { get: () => false });
  Object.defineProperty(document, "visibilityState", { get: () => "visible" });
  const pending = new Map(), mediaListeners = new Set(); let id = 0, now = performance.now(), calls = [];
  const media = { matches: false, addEventListener: (_, fn) => mediaListeners.add(fn), removeEventListener: (_, fn) => mediaListeners.delete(fn) };
  window.matchMedia = () => media;
  window.requestAnimationFrame = fn => { pending.set(++id, fn); return id; };
  window.cancelAnimationFrame = n => pending.delete(n);
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const contexts = new WeakMap();
  dom.window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ width: 1180, height: 148 });
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    if (!contexts.has(this)) contexts.set(this, {
      globalAlpha: 1, setTransform() {}, clearRect() { calls = []; },
      createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; }, putImageData() {},
      drawImage(texture, x, y, width, height) { calls.push({ texture, x, y, width, height, alpha: this.globalAlpha }); },
    });
    return contexts.get(this);
  };
  const root = createRoot(document.getElementById("root"));
  const render = (playing = true, volume = 0.5) => act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(AudioGlowCanvas, { isPlaying: playing, volume }))));
  const step = (ms = 16) => { now += ms; const frames = [...pending.values()]; pending.clear(); frames.forEach(fn => fn(now)); };
  const bands = new Array(40).fill(0.5);
  const publish = sourceKey => publishVisualizerFrame({ glowBands: bands, sourceKey });
  try {
    publish("a"); await render(); step(); step(34);
    assert.equal(calls.length, 80, "one frame draws all orange and pink sprites");
    assert.equal(new Set(calls.slice(0, 40).map(c => c.texture)).size, 1, "orange texture is reused");
    assert.notEqual(calls[0].texture, calls[40].texture, "the second layer has its own material");
    assert.equal(calls[0].width, 1180 * 9 / 48);
    assert.ok(calls.every(c => Math.abs(c.y + c.height - 148) < 1e-9), "every sprite stays anchored to the bottom");
    assert.ok(calls[40].height > calls[0].height && calls[40].alpha > calls[0].alpha, "pink responds faster and more strongly");
    for (const state of ["pause", "mute", "reduce"]) {
      if (state === "pause") await render(false);
      if (state === "mute") await render(true, 0);
      if (state === "reduce") await act(() => { media.matches = true; mediaListeners.forEach(fn => fn()); });
      for (let n = 0; n < 30; n++) step();
      assert.equal(calls.length, 0, `${state} clears the real signal`);
      assert.equal(pending.size, 0, `${state} leaves no continuous frame loop`);
      await act(() => { media.matches = false; mediaListeners.forEach(fn => fn()); });
      await render(); step(); step(100);
    }
    publish("b"); step();
    assert.equal(calls.length, 0, "a source switch clears the preceding song's light");
  } finally {
    await act(() => root.unmount()); assert.equal(pending.size, 0); assert.equal(mediaListeners.size, 0); dom.window.close();
  }
});
