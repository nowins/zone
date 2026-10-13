import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createMosaicColorPalette, extractMosaicColorPalette } from "../.tmp/visualizer-tests/utils/nowPlayingCanvas.js";

await build({ entryPoints: ["src/components/NowPlayingArtistCanvas.tsx"], outfile: ".tmp/artist-canvas-tests/runtime.js",
  bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent",
  plugins: [{ name: "controlled-artist-gpu", setup(build) {
    build.onResolve({ filter: /\/irisGpuRenderer$/ }, () => ({ path: "artist-gpu", namespace: "controlled-artist-gpu" }));
    build.onLoad({ filter: /.*/, namespace: "controlled-artist-gpu" }, () => ({ contents: `
      export function createIrisGpuRenderer(document) {
        const fixture = window.__irisFixture;
        fixture.attempts++;
        if (fixture.failCreate) throw new Error('GPU unavailable');
        if (!fixture.enabled) return null;
        const canvas = document.createElement('canvas');
        const instance = { disposed:false, frame:null };
        fixture.instances.push(instance);
        return {
          get available() { return !instance.disposed && !fixture.lost; },
          begin(frame) { instance.frame = {...frame}; return !fixture.failBegin; },
          photo(photo) {
            fixture.photos.push({ ...photo, image:photo.image.path, frame:instance.frame });
            if (fixture.failPath === photo.image.path) return false;
            canvas.path = 'gpu:' + photo.image.path;
            return true;
          },
          finishPhoto() { return fixture.failFinish ? null : canvas; },
          dispose() { instance.disposed = true; }
        };
      }
    ` }));
  } }] });
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

test("GPU photos receive raw decoded surfaces, screen-space crop vertices and one material opacity", async () => {
  const env = await fixture({ gpu: true });
  try {
    env.advance(5200);
    const photo = env.gpuPhotos().at(-1);
    assert.equal(photo.image, "photo-a");
    assert.equal(photo.opacity, 1);
    assert.deepEqual(photo.frame, { width: 1180, height: 760, rasterScale: 1, dpiScale: 1, transparent: true });
    assert.ok(photo.vertices.every(vertex => vertex.w === 1));
    assert.ok(photo.vertices[0].x <= 0 && photo.vertices[1].x >= 1180);
    assert.ok(photo.vertices[0].y <= 0 && photo.vertices[2].y >= 760);
    assert.equal(photo.vertices[0].y, photo.vertices[1].y);
    assert.equal(photo.vertices[2].x, photo.vertices[1].x);
    assert.deepEqual(env.lastDraws().map(draw => draw.path), ["gpu:photo-a"]);
    assert.equal(env.fallback(), false, "GPU material must not receive the old CSS darkening");
    env.advance(30_200);
    const draws = env.lastDraws();
    assert.deepEqual(draws.map(draw => draw.path), ["gpu:photo-a", "gpu:photo-b"]);
    assert.equal(draws[0].alpha, 1);
    assert.ok(draws[1].alpha > 0 && draws[1].alpha < 1);
    assert.ok(env.gpuPhotos().slice(-2).every(photo => photo.opacity === 1), "scene alpha is applied after shader alpha accumulation");
  } finally { await env.close(); }
});

test("GPU light time freezes on pause, hidden and reduced motion without restarting same-artist scenes", async () => {
  const env = await fixture({ gpu: true });
  try {
    env.advance(5200);
    const time = env.gpuPhotos().at(-1).timeSeconds;
    await env.render({ playing: false });
    env.step(40);
    assert.equal(env.gpuPhotos().at(-1).timeSeconds, time);
    assert.equal(env.frameCount(), 0);
    await env.render({ playing: true });
    env.step(40);
    assert.equal(env.gpuPhotos().at(-1).timeSeconds, time, "resume starts with a reset frame clock");
    env.advance(160);
    const resumed = env.gpuPhotos().at(-1).timeSeconds;
    assert.ok(resumed > time);
    env.hide(true);
    env.advance(40_000);
    env.hide(false);
    env.step(40);
    assert.equal(env.gpuPhotos().at(-1).timeSeconds, resumed);
    await env.reduce(true);
    env.step(40);
    await env.render({ active: 1 });
    env.step(40);
    assert.equal(env.gpuPhotos().at(-1).timeSeconds, resumed);
    assert.equal(env.gpuPhotos().at(-1).image, "photo-a");
    assert.equal(env.frameCount(), 0);
  } finally { await env.close(); }
});

test("DPI-only changes redraw a sleeping GPU photo with uncapped lighting DPI and bounded raster", async () => {
  const env = await fixture({ gpu: true });
  try {
    env.advance(5200);
    await env.render({ playing: false });
    env.step(40);
    assert.equal(env.resolutionListeners(), 1, "StrictMode retains only the current resolution observer");
    env.dpi(3);
    env.step(40);
    const photo = env.gpuPhotos().at(-1);
    assert.equal(photo.frame.dpiScale, 3);
    assert.equal(photo.frame.rasterScale, 2);
    assert.equal(env.canvasSize().width, 2360);
    assert.equal(env.canvasSize().height, 1520);
    assert.equal(env.frameCount(), 0);
    assert.equal(env.resolutionListeners(), 1);
    env.dpi(1.25);
    env.step(40);
    assert.equal(env.gpuPhotos().at(-1).frame.dpiScale, 1.25);
    assert.equal(env.canvasSize().width, 1475);
    env.windowResize();
    assert.equal(env.frameCount(), 0, "an unchanged resize leaves the stopped scene asleep");
  } finally { await env.close(); }
});

test("a failed GPU handoff redraws both images through Canvas and keeps fallback work bounded", async () => {
  const env = await fixture({ gpu: true });
  try {
    env.advance(35_100);
    env.failGpu("photo-b");
    env.step(40);
    assert.deepEqual(env.lastDraws().map(draw => draw.path), ["photo-a", "photo-b"], "partial GPU pixels are cleared before fallback composition");
    assert.equal(env.fallback(), true);
    assert.equal(env.disposedGpuCount(), 1);
    const attempts = env.gpuAttempts();
    env.advance(400);
    assert.equal(env.gpuAttempts(), attempts, "a failed renderer is not recreated every frame");
    assert.equal(env.opacity(), 1);
  } finally { await env.close(); }
});

test("GPU creation, context and output failures keep a complete Canvas photograph available", async () => {
  for (const failure of ["failCreate", "failBegin", "failFinish", "lost"]) {
    const env = await fixture({ gpu: true });
    try {
      env.failGpuStage(failure);
      env.advance(5200);
      assert.equal(env.opacity(), 1, failure);
      assert.equal(env.fallback(), true, failure);
      assert.deepEqual(env.lastDraws().map(draw => draw.path), ["photo-a"], failure);
      assert.equal(env.gpuAttempts(), 1, "a persistent GPU failure is attempted once per pool or geometry change");
      assert.deepEqual(env.opaqueChanges, [true]);
    } finally { await env.close(); }
  }
});

test("retired GPU pixels retain their grading and pool changes release old GPU textures", async () => {
  const env = await fixture({ gpu: true });
  try {
    env.advance(5200);
    await env.render({ tracks: makeTracks("Other", ["other-a", "other-b"]), pending: ["other-a", "other-b"] });
    env.step(40);
    assert.equal(env.disposedGpuCount(), 1);
    assert.equal(env.fallback(), false, "retired GPU pixels must not acquire the fallback CSS filter");
    assert.deepEqual(env.opaqueChanges, [true, false]);
    env.advance(2200);
    await env.finishImage("other-a");
    await env.finishImage("other-b");
    env.advance(5200);
    assert.equal(env.gpuInstances(), 2);
    assert.equal(env.opacity(), 1);
    await env.render({ tracks: makeTracks("Other", ["other-a", "other-b", "other-c"]) });
    env.step(40);
    assert.equal(env.disposedGpuCount(), 2, "a changed decoded pool drops removed GPU source ownership");
    assert.equal(env.gpuPhotos().at(-1).image, "other-a", "refreshing materials keeps the current scene");
    assert.equal(env.opacity(), 1);
  } finally { await env.close(); }
});

test("cover colors use a bounded decode and canceled old covers cannot replace the current photo palette", async () => {
  const env = await fixture({ gpu: true, cover: "cover-red", pending: ["cover-red"],
    coverColors: { "cover-red": [220, 30, 20, 255], "cover-blue": [20, 40, 220, 255] } });
  try {
    env.advance(5200);
    const initial = env.gpuPhotos().at(-1).palette;
    await env.render({ cover: "cover-blue", active: 1 });
    env.step(40);
    assert.notDeepEqual(env.gpuPhotos().at(-1).palette, initial);
    assert.equal(env.gpuPhotos().at(-1).image, "photo-a");
    assert.equal(env.opacity(), 1);
    const decoded = env.imageRasters().find(raster => raster.path === "cover-blue");
    assert.ok(decoded.width <= 48 && decoded.height <= 48);
    env.advance(16_000);
    const blue = env.gpuPhotos().at(-1).palette;
    await env.finishImage("cover-red");
    env.step(40);
    assert.deepEqual(env.gpuPhotos().at(-1).palette, blue);
    assert.ok(env.imageSources().includes(""), "completed and canceled decodes release their source handles");
  } finally { await env.close(); }
});

test("same-artist cover retargeting keeps every RGB channel continuous and reaches the latest target", async () => {
  const colors = { "cover-red": [220, 30, 20, 255], "cover-blue": [20, 40, 220, 255], "cover-green": [30, 210, 50, 255] };
  const env = await fixture({ gpu: true, cover: "cover-red", coverColors: colors });
  try {
    env.advance(5200);
    const red = solidCoverPalette(colors["cover-red"]);
    const blue = solidCoverPalette(colors["cover-blue"]);
    const green = solidCoverPalette(colors["cover-green"]);
    assert.deepEqual(env.gpuPhotos()[0].palette, red, "a resolved cover initializes before the first photo is rendered");
    await env.render({ cover: "cover-blue", active: 1 });
    env.step(0);
    assert.deepEqual(env.gpuPhotos().at(-1).palette, red, "the async result changes the target, not the visible RGB values");
    let previous = red;
    for (let frame = 0; frame < 12; frame++) {
      env.step(40);
      const current = env.gpuPhotos().at(-1).palette;
      for (let index = 0; index < current.length; index++) {
        for (const channel of ["r", "g", "b"]) {
          assert.ok(Math.abs(current[index][channel] - previous[index][channel]) <= Math.abs(blue[index][channel] - previous[index][channel]) * 0.04 + 1e-9);
          assert.ok(Math.abs(current[index][channel] - blue[index][channel]) <= Math.abs(previous[index][channel] - blue[index][channel]) + 1e-9);
        }
      }
      previous = current;
    }
    await env.render({ cover: "cover-green" });
    env.step(0);
    assert.deepEqual(env.gpuPhotos().at(-1).palette, previous, "a second retarget starts at the in-flight color");
    env.advance(16_000);
    assert.deepEqual(env.gpuPhotos().at(-1).palette, green);
    assert.equal(env.gpuPhotos().at(-1).image, "photo-a");
    assert.deepEqual(env.opaqueChanges, [true]);
  } finally { await env.close(); }
});

test("paused and reduced photos finish necessary palette convergence without advancing lights or crops", async () => {
  for (const mode of ["paused", "reduced"]) {
    const colors = { "cover-red": [220, 30, 20, 255], "cover-blue": [20, 40, 220, 255] };
    const env = await fixture({ gpu: true, cover: "cover-red", coverColors: colors });
    try {
      env.advance(5200);
      if (mode === "paused") await env.render({ playing: false });
      else await env.reduce(true);
      env.step(40);
      const frozen = env.gpuPhotos().at(-1);
      assert.equal(env.frameCount(), 0);
      await env.render({ cover: "cover-blue" });
      env.step(40);
      assert.deepEqual(env.gpuPhotos().at(-1).palette, frozen.palette, "a sleeping clock resumes from delta zero");
      assert.equal(env.frameCount(), 1, "visible pending colors wake a bounded settle loop");
      env.advance(16_000);
      const final = env.gpuPhotos().at(-1);
      assert.deepEqual(final.palette, solidCoverPalette(colors["cover-blue"]));
      assert.equal(final.timeSeconds, frozen.timeSeconds, "color settling must not move the light field");
      assert.deepEqual(final.vertices, frozen.vertices, "color settling must not move the photo crop");
      assert.equal(env.frameCount(), 0, "the channel threshold snaps exactly to the target and sleeps");
    } finally { await env.close(); }
  }
});

test("hidden palette transitions preserve visible progress and a discarded artist cannot keep a color loop alive", async () => {
  const colors = { "cover-red": [220, 30, 20, 255], "cover-blue": [20, 40, 220, 255] };
  const env = await fixture({ gpu: true, cover: "cover-red", coverColors: colors });
  try {
    env.advance(5200);
    await env.render({ playing: false, cover: "cover-blue" });
    env.advance(400);
    const before = env.gpuPhotos().at(-1);
    env.hide(true);
    env.advance(40_000);
    env.hide(false);
    env.step(40);
    assert.deepEqual(env.gpuPhotos().at(-1).palette, before.palette, "restoration cannot consume hidden color time");
    assert.equal(env.gpuPhotos().at(-1).timeSeconds, before.timeSeconds);
    await env.render({ tracks: makeTracks("Other", ["single"]) });
    env.advance(2200);
    assert.equal(env.opacity(), 0);
    assert.equal(env.frameCount(), 0, "palette work stops once no current or retired photograph is visible");
  } finally { await env.close(); }
});

test("a failed cover smoothly returns a paused photo to the fallback palette and then sleeps", async () => {
  const env = await fixture({ gpu: true, cover: "cover-red", failed: ["cover-bad"],
    coverColors: { "cover-red": [220, 30, 20, 255] } });
  const fallback = createMosaicColorPalette({ r: 62, g: 50, b: 44 });
  try {
    env.advance(5200);
    await env.render({ playing: false });
    env.step(40);
    const before = env.gpuPhotos().at(-1);
    await env.render({ cover: "cover-bad" });
    env.step(40);
    assert.deepEqual(env.gpuPhotos().at(-1).palette, before.palette);
    env.advance(16_000);
    assert.deepEqual(env.gpuPhotos().at(-1).palette, fallback);
    assert.equal(env.gpuPhotos().at(-1).timeSeconds, before.timeSeconds);
    assert.equal(env.frameCount(), 0);
  } finally { await env.close(); }
});

function solidCoverPalette(color) {
  // The fixture's 1200x900 source becomes the component's 48x36 color raster.
  const data = new Uint8ClampedArray(48 * 36 * 4);
  for (let index = 0; index < data.length; index += 4) data.set(color, index);
  return extractMosaicColorPalette(data);
}

function makeTracks(artist, paths) {
  return [0, 1].map(index => ({ id: `${artist}-${index}`, title: `Song ${index}`, album: `Album ${index}`, artist,
    artist_image_path: paths[0], artist_images: paths.slice(1).map(path => ({ path })) }));
}

async function fixture({ paths = ["photo-a", "photo-b"], pending = [], failed = [], gpu = false, cover = null, coverColors = {} } = {}) {
  const dom = new JSDOM('<body><div id="root"></div></body>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.__TAURI_INTERNALS__ = { convertFileSrc: path => path };
  const frames = new Map();
  let nextId = 0, now = 0, hidden = false, width = 1180, height = 760, resize;
  let draws = [], lastDraws = [];
  const imageRasters = [], imageSources = [];
  const gpuFixture = { enabled: gpu, attempts: 0, instances: [], photos: [], lost: false, failBegin: false, failFinish: false, failPath: null };
  window.__irisFixture = gpuFixture;
  const unresolved = new Set(pending);
  const failures = new Set(failed);
  const resolvers = new Map();
  const mediaListeners = new Set();
  const media = { matches: false, addEventListener: (_type, listener) => mediaListeners.add(listener),
    removeEventListener: (_type, listener) => mediaListeners.delete(listener) };
  const resolutionQueries = [];
  window.matchMedia = query => {
    if (!query.startsWith("(resolution:")) return media;
    const listeners = new Set();
    const resolution = { query, listeners, addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener) };
    resolutionQueries.push(resolution);
    return resolution;
  };
  window.requestAnimationFrame = callback => { frames.set(++nextId, callback); return nextId; };
  window.cancelAnimationFrame = id => frames.delete(id);
  Object.defineProperty(document, "hidden", { get: () => hidden });
  Object.defineProperty(document, "visibilityState", { get: () => hidden ? "hidden" : "visible" });
  globalThis.ResizeObserver = class { constructor(callback) { resize = callback; } observe() {} disconnect() {} };
  globalThis.Image = class {
    complete = true;
    naturalWidth = 1200;
    naturalHeight = 900;
    set src(value) { this.source = value; imageSources.push(value); }
    get src() { return this.source; }
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
    const context = { globalAlpha: 1, setTransform() {}, clearRect() { if (canvas.classList.contains("now-artist-canvas")) draws = []; },
      drawImage(image, ...dimensions) {
        if (image instanceof globalThis.Image) { canvas.path = image.src; imageRasters.push({ path: image.src, width: canvas.width, height: canvas.height }); }
        else if (canvas.classList.contains("now-artist-canvas")) draws.push({ path: image.path ?? "snapshot", alpha: this.globalAlpha, dimensions });
        else canvas.path = "snapshot";
      },
      getImageData() {
        const color = coverColors[canvas.path] ?? [128, 128, 128, 255];
        const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
        for (let index = 0; index < data.length; index += 4) data.set(color, index);
        return { data };
      } };
    contexts.set(this, context);
    return context;
  };
  const root = createRoot(document.getElementById("root"));
  let tracks = makeTracks("Artist", paths), active = 0, playing = true;
  if (cover) tracks = tracks.map(track => ({ ...track, cover_path: cover }));
  const opaqueChanges = [];
  const render = async (changes = {}) => act(async () => {
    tracks = changes.tracks ?? tracks;
    if ("cover" in changes) tracks = tracks.map(track => ({ ...track, cover_path: changes.cover }));
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
    gpuPhotos: () => gpuFixture.photos, gpuAttempts: () => gpuFixture.attempts, gpuInstances: () => gpuFixture.instances.length,
    disposedGpuCount: () => gpuFixture.instances.filter(instance => instance.disposed).length,
    failGpu: path => { gpuFixture.failPath = path; },
    failGpuStage: stage => { gpuFixture[stage] = true; },
    fallback: () => document.querySelector(".now-artist-canvas").classList.contains("is-fallback"),
    imageRasters: () => imageRasters, imageSources: () => imageSources,
    canvasSize: () => { const canvas = document.querySelector(".now-artist-canvas"); return { width: canvas.width, height: canvas.height }; },
    resolutionListeners: () => resolutionQueries.reduce((total, query) => total + query.listeners.size, 0),
    dpi(value) { window.devicePixelRatio = value; [...resolutionQueries].forEach(query => [...query.listeners].forEach(listener => listener())); },
    windowResize() { window.dispatchEvent(new window.Event("resize")); },
    advance(ms) { for (let elapsed = 0; elapsed < ms;) { const delta = Math.min(40, ms - elapsed); step(delta); elapsed += delta; } },
    frameCount: () => frames.size,
    opacity: () => Number(document.querySelector(".now-artist-canvas").style.opacity || 0),
    hide(value) { hidden = value; document.dispatchEvent(new window.Event("visibilitychange")); },
    reduce: async value => act(async () => { media.matches = value; mediaListeners.forEach(listener => listener()); }),
    resize(nextWidth = width, nextHeight = height) { width = nextWidth; height = nextHeight; resize(); },
    finishImage: async path => act(async () => { resolvers.get(path)?.(); await new Promise(resolve => setImmediate(resolve)); }),
    async close() {
      await act(async () => root.unmount());
      assert.equal(frames.size, 0);
      assert.equal(mediaListeners.size, 0);
      assert.equal(resolutionQueries.reduce((count, query) => count + query.listeners.size, 0), 0);
      assert.ok(gpuFixture.instances.every(instance => instance.disposed));
      dom.window.close();
    },
  };
}
