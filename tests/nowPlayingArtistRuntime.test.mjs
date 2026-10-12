import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

await build({ entryPoints: ["src/components/NowPlayingArtistCanvas.tsx"], outfile: ".tmp/artist-canvas-tests/runtime.js",
  bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { NowPlayingArtistCanvas } = await import("../.tmp/artist-canvas-tests/runtime.js");

test("the artist layer needs two decoded photos and reports opacity only at complete handoffs", async () => {
  const env = await fixture({ pending: ["photo-b"] });
  try {
    env.advance(5200);
    assert.equal(env.opacity(), 0);
    assert.deepEqual(env.opaqueChanges, []);
    await env.finishImage("photo-b");
    env.advance(2080);
    assert.equal(env.opacity(), 1);
    assert.deepEqual(env.opaqueChanges, [true]);
    assert.ok(env.lastDraws().every(draw => draw.path === "photo-a"));
    await env.render({ active: 1 });
    env.advance(500);
    assert.deepEqual(env.opaqueChanges, [true], "same-artist song changes keep the current scene opaque");
  } finally { await env.close(); }
});

test("single or failed photos keep the grid visible without a continuous frame loop", async () => {
  for (const options of [{ paths: ["single"] }, { failed: ["photo-b"] }]) {
    const env = await fixture(options);
    try {
      env.step(40);
      assert.equal(env.frameCount(), 0, "a settled insufficient pool needs no waiting loop");
      env.advance(6000);
      assert.equal(env.opacity(), 0);
      assert.equal(env.frameCount(), 0);
      assert.deepEqual(env.opaqueChanges, []);
    } finally { await env.close(); }
  }
});

test("cold reduced-motion entry keeps the static grid and waits for normal playback motion before starting photos", async () => {
  const env = await fixture();
  try {
    await env.reduce(true);
    env.step(40);
    assert.equal(env.opacity(), 0);
    assert.equal(env.frameCount(), 0);
    await env.render({ active: 1 });
    env.advance(10_000);
    assert.deepEqual(env.opaqueChanges, []);
    await env.reduce(false);
    env.advance(5200);
    assert.equal(env.opacity(), 1);
  } finally { await env.close(); }
});

test("new same-artist metadata extends the decoded pool without resetting an already visible photo", async () => {
  const env = await fixture();
  try {
    env.advance(5200);
    const before = env.lastDraws()[0].dimensions;
    await env.render({ tracks: makeTracks("Artist", ["photo-a", "photo-b", "photo-c"]) });
    env.step(40);
    assert.equal(env.opacity(), 1);
    assert.equal(env.lastDraws()[0].path, "photo-a");
    assert.ok(Math.abs(env.lastDraws()[0].dimensions[0] - before[0]) < 2, "the running slide advances instead of returning to its start");
    assert.deepEqual(env.opaqueChanges, [true]);
  } finally { await env.close(); }
});

test("pause finishes the longer photo dissolve and sleeps without moving the scene", async () => {
  const env = await fixture();
  try {
    env.advance(4040);
    assert.ok(env.opacity() > 0 && env.opacity() < 1);
    await env.render({ playing: false });
    const dimensions = env.step(40)[0].dimensions;
    env.advance(2080);
    assert.equal(env.opacity(), 1);
    assert.equal(env.frameCount(), 0, "the 2000ms handoff finishes even beyond the mosaic's settle budget");
    assert.deepEqual(env.lastDraws()[0].dimensions, dimensions, "pause preserves the current crop");
    await env.render({ playing: true });
    env.advance(100);
    assert.equal(env.frameCount(), 1);
  } finally { await env.close(); }
});

test("32-second photo changes retain the old opaque image underneath and pause completes the tail", async () => {
  const env = await fixture();
  try {
    env.advance(5200);
    env.advance(30_200);
    const changing = env.lastDraws();
    assert.deepEqual(changing.map(draw => draw.path), ["photo-a", "photo-b"]);
    assert.equal(changing[0].alpha, 1);
    assert.ok(changing[1].alpha > 0 && changing[1].alpha < 1);
    await env.render({ playing: false });
    env.advance(2200);
    assert.deepEqual(env.lastDraws().map(draw => draw.path), ["photo-b"]);
    assert.equal(env.frameCount(), 0);
    assert.deepEqual(env.opaqueChanges, [true]);
  } finally { await env.close(); }
});

test("hidden windows freeze the photo clock and restoration cannot jump thirty seconds", async () => {
  const env = await fixture();
  try {
    env.advance(5200);
    const before = env.lastDraws()[0].dimensions;
    env.hide(true);
    env.advance(40_000);
    assert.equal(env.frameCount(), 0);
    env.hide(false);
    const restored = env.step(40);
    assert.equal(restored[0].path, "photo-a");
    assert.deepEqual(restored[0].dimensions, before);
    env.advance(500);
    assert.equal(env.lastDraws()[0].path, "photo-a");
    document.documentElement.dataset.zoneWindowVisible = "false";
    document.dispatchEvent(new window.Event("zone-window-visibility"));
    assert.equal(env.frameCount(), 0);
    delete document.documentElement.dataset.zoneWindowVisible;
    document.dispatchEvent(new window.Event("zone-window-visibility"));
    env.step(40);
    assert.equal(env.frameCount(), 1);
  } finally { await env.close(); }
});

test("reduced motion completes a photo transition immediately and stops automatic scenes", async () => {
  const env = await fixture();
  try {
    env.advance(4040);
    await env.reduce(true);
    env.step(40);
    assert.equal(env.opacity(), 1);
    assert.equal(env.frameCount(), 0);
    const crop = env.lastDraws()[0].dimensions;
    env.advance(40_000);
    await env.render({ active: 1 });
    env.step(40);
    assert.deepEqual(env.lastDraws()[0].dimensions, crop);
    await env.reduce(false);
    env.advance(120);
    assert.equal(env.frameCount(), 1);
  } finally { await env.close(); }
});

test("artist changes reveal the grid before retiring old pixels, and stale decode completions cannot return", async () => {
  const env = await fixture();
  try {
    env.advance(5200);
    const oldOpacity = env.opacity();
    const newTracks = makeTracks("Other", ["other-a", "other-b"]);
    await env.render({ tracks: newTracks, pending: ["other-a", "other-b"] });
    assert.deepEqual(env.opaqueChanges, [true, false], "the grid wakes before the photo starts fading");
    assert.equal(env.opacity(), oldOpacity, "retirement retains the visible opacity until the next frame");
    env.step(40);
    assert.ok(env.opacity() < oldOpacity && env.opacity() > 0.99, "the first 40ms frame advances the fade continuously");
    env.advance(2200);
    assert.equal(env.opacity(), 0);
    await env.render({ tracks: makeTracks("Third", ["single"]) });
    await env.finishImage("other-a");
    await env.finishImage("other-b");
    env.advance(6000);
    assert.equal(env.opacity(), 0);
    assert.equal(env.frameCount(), 0);
    assert.deepEqual(env.opaqueChanges, [true, false]);
  } finally { await env.close(); }
});

test("a real resize redraws a paused photo but an unchanged notification leaves it asleep", async () => {
  const env = await fixture();
  try {
    env.advance(5200);
    await env.render({ playing: false });
    env.advance(2200);
    assert.equal(env.frameCount(), 0);
    env.resize();
    assert.equal(env.frameCount(), 0);
    env.resize(920, 620);
    const frame = env.step(40);
    assert.equal(frame[0].path, "photo-a");
    assert.equal(env.frameCount(), 0);
    assert.equal(env.opacity(), 1);
  } finally { await env.close(); }
});

function makeTracks(artist, paths) {
  return [0, 1].map(index => ({ id: `${artist}-${index}`, title: `Song ${index}`, album: `Album ${index}`, artist,
    artist_image_path: paths[0], artist_images: paths.slice(1).map(path => ({ path })) }));
}

async function fixture({ paths = ["photo-a", "photo-b"], pending = [], failed = [] } = {}) {
  const dom = new JSDOM('<body><div id="root"></div></body>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.__TAURI_INTERNALS__ = { convertFileSrc: path => path };
  const frames = new Map();
  let nextId = 0, now = 0, hidden = false, width = 1180, height = 760, resize;
  let draws = [], lastDraws = [];
  const unresolved = new Set(pending);
  const failures = new Set(failed);
  const resolvers = new Map();
  const mediaListeners = new Set();
  const media = { matches: false, addEventListener: (_type, listener) => mediaListeners.add(listener),
    removeEventListener: (_type, listener) => mediaListeners.delete(listener) };
  window.matchMedia = () => media;
  window.requestAnimationFrame = callback => { frames.set(++nextId, callback); return nextId; };
  window.cancelAnimationFrame = id => frames.delete(id);
  Object.defineProperty(document, "hidden", { get: () => hidden });
  Object.defineProperty(document, "visibilityState", { get: () => hidden ? "hidden" : "visible" });
  globalThis.ResizeObserver = class { constructor(callback) { resize = callback; } observe() {} disconnect() {} };
  globalThis.Image = class {
    complete = true;
    naturalWidth = 1200;
    naturalHeight = 900;
    decode() {
      if (failures.has(this.src)) return Promise.reject(new Error("bad image"));
      if (unresolved.has(this.src)) return new Promise(resolve => resolvers.set(this.src, resolve));
      return Promise.resolve();
    }
    addEventListener() {}
    removeEventListener() {}
  };
  dom.window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ width, height });
  const contexts = new WeakMap();
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    if (contexts.has(this)) return contexts.get(this);
    const canvas = this;
    const context = { globalAlpha: 1, setTransform() {}, clearRect() {},
      drawImage(image, ...dimensions) {
        if (image instanceof globalThis.Image) canvas.path = image.src;
        else if (canvas.className === "now-artist-canvas") draws.push({ path: image.path ?? "snapshot", alpha: this.globalAlpha, dimensions });
        else canvas.path = "snapshot";
      } };
    contexts.set(this, context);
    return context;
  };
  const root = createRoot(document.getElementById("root"));
  let tracks = makeTracks("Artist", paths), active = 0, playing = true;
  const opaqueChanges = [];
  const render = async (changes = {}) => act(async () => {
    tracks = changes.tracks ?? tracks;
    active = changes.active ?? active;
    playing = changes.playing ?? playing;
    changes.pending?.forEach(path => unresolved.add(path));
    root.render(React.createElement(React.StrictMode, null, React.createElement(NowPlayingArtistCanvas,
      { tracks, activeTrack: tracks[active], isPlaying: playing, onOpaqueChange: value => opaqueChanges.push(value) })));
    await new Promise(resolve => setImmediate(resolve));
  });
  await render();
  const step = (ms = 40) => {
    now += ms;
    draws = [];
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(now));
    if (callbacks.length) lastDraws = draws;
    return draws;
  };
  return { render, step, opaqueChanges, lastDraws: () => lastDraws,
    advance(ms) { for (let elapsed = 0; elapsed < ms;) { const delta = Math.min(40, ms - elapsed); step(delta); elapsed += delta; } },
    frameCount: () => frames.size,
    opacity: () => Number(document.querySelector(".now-artist-canvas").style.opacity || 0),
    hide(value) { hidden = value; document.dispatchEvent(new window.Event("visibilitychange")); },
    reduce: async value => act(async () => { media.matches = value; mediaListeners.forEach(listener => listener()); }),
    resize(nextWidth = width, nextHeight = height) { width = nextWidth; height = nextHeight; resize(); },
    finishImage: async path => act(async () => { resolvers.get(path)?.(); await new Promise(resolve => setImmediate(resolve)); }),
    async close() { await act(async () => root.unmount()); assert.equal(frames.size, 0); assert.equal(mediaListeners.size, 0); dom.window.close(); },
  };
}
