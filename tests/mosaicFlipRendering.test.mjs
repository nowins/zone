import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

await build({ stdin: { contents: `export { NowPlayingMosaicCanvas } from './src/components/NowPlayingMosaicCanvas';
export { buildCanvasMosaicTiles } from './src/utils/nowPlayingCanvas';`, resolveDir: process.cwd(), loader: "ts" },
  outfile: ".tmp/mosaic-render-tests/runtime.js", bundle: true, packages: "external", format: "esm", platform: "browser",
  define: { "import.meta.env.DEV": "false" }, logLevel: "silent",
  plugins: [{ name: "observed-wall-renderer", setup(build) {
    build.onResolve({ filter: /\.ts$/, namespace: "observed-wall-renderer" }, args => ({ path: args.path, namespace: "file" }));
    build.onResolve({ filter: /\/irisGpuRenderer$/ }, () => ({ path: "wall-gpu", namespace: "observed-wall-renderer" }));
    build.onResolve({ filter: /\/nowPlayingCanvas$/ }, () => ({ path: "wall-clock", namespace: "observed-wall-renderer" }));
    build.onLoad({ filter: /wall-clock/, namespace: "observed-wall-renderer" }, () => ({ contents: `
      import * as original from ${JSON.stringify(`${process.cwd().replaceAll("\\", "/")}/src/utils/nowPlayingCanvas.ts`)};
      export * from ${JSON.stringify(`${process.cwd().replaceAll("\\", "/")}/src/utils/nowPlayingCanvas.ts`)};
      export function updateMosaicFlipState(...args) {
        const state = original.updateMosaicFlipState(...args);
        window.__mosaicObservedFlip = {...state};
        return state;
      }
      export function advanceMosaicArtwork(...args) {
        window.__mosaicAdvanceCalls++;
        return original.advanceMosaicArtwork(...args);
      }
    ` }));
    build.onLoad({ filter: /wall-gpu/, namespace: "observed-wall-renderer" }, () => ({ contents: `
      export { irisCoverCropUv, irisMediaImageSize } from ${JSON.stringify(`${process.cwd().replaceAll("\\", "/")}/src/utils/irisGpuRenderer.ts`)};
      export function createIrisGpuRenderer(document) {
        const fixture = window.__mosaicGpuFixture;
        fixture.attempts++;
        if (fixture.failCreate) throw new Error('GPU context rejected');
        if (!fixture.enabled) return null;
        const canvas = document.createElement('canvas');
        canvas.gpuWall = true;
        const instance = {disposed:false, frame:null};
        fixture.instances.push(instance);
        return {
          get available() { return !instance.disposed && !fixture.lost; },
          begin(size) {
            fixture.begins++;
            instance.frame = {size:{...size},covers:[]};
            fixture.frames.push(instance.frame);
            return !fixture.failBegin;
          },
          cover(options) {
            instance.frame.covers.push(options);
            return instance.frame.covers.length !== fixture.failCoverAt;
          },
          finishWall(options) {
            fixture.finishes++;
            if (fixture.failFinish) return null;
            canvas.frame = instance.frame;
            return canvas;
          },
          dispose() { instance.disposed = true; }
        };
      }
    ` }));
  } }] });
const { NowPlayingMosaicCanvas, buildCanvasMosaicTiles } = await import("../.tmp/mosaic-render-tests/runtime.js");

test("the actual wall renders one back cover at the apex and keeps it after the turn", async () => {
  const fixture = await createWallFixture();
  try {
    const turn = fixture.findTurn();
    const front = turn.images[0].cover;
    let back;
    let secondHalf = false;
    let lastAlpha = 0;
    for (let step = 0; step < 80; step++) {
      const frame = fixture.step(40);
      const tile = frame.filter(draw => draw.slot === turn.slot);
      if (tile.some(draw => draw.cover !== front)) {
        secondHalf = true;
        back ??= tile.find(draw => draw.cover !== front).cover;
      }
      if (secondHalf) {
        assert.deepEqual(tile.map(draw => draw.cover), [back], "a flip must swap faces edge-on, without a second dissolve");
        assert.ok(tile[0].alpha >= lastAlpha && tile[0].alpha <= 1, "the captured back face fades in continuously");
        lastAlpha = tile[0].alpha;
      }
    }
    assert.ok(back, "a different decoded cover should appear on the back");
    assert.equal(lastAlpha, 1, "the back face finishes its separate fade tail");
    fixture.resize();
    assert.deepEqual(fixture.step().filter(draw => draw.slot === turn.slot).map(draw => draw.cover), [back],
      "a repeated ResizeObserver notification must not restore the original assignment");
  } finally {
    await fixture.dispose();
  }
});

test("rapid track changes wait for the captured back face to land before replacing the pool", async () => {
  const fixture = await createWallFixture();
  try {
    const turn = fixture.findTurn();
    const back = fixture.findBack(turn);
    await fixture.render({ active: 1 });
    await fixture.render({ active: 2 });
    const landed = fixture.finishTurn(turn, back);
    assert.equal(landed[0].cover, back, "the landing frame retains the cover seen during the turn");
    await fixture.render({ playing: false });
    const settled = fixture.step(1600).filter(draw => draw.slot === turn.slot);
    fixture.step(1600);
    assert.ok(settled.length > 0, "the replacement pool retains decoded artwork");
    assert.ok(fixture.step().every(draw => draw.alpha === 1), "rapid replacements eventually release the old surfaces");
  } finally { await fixture.dispose(); }
});

test("a pool queued early in a turn still renders and settles after playback pauses", async () => {
  const fixture = await createWallFixture();
  try {
    fixture.findTurn();
    const tracks = ["paused-a", "paused-b", "paused-c"].map(id => ({id, title:id, album:id, artist:"Replacement", cover_path:`${id}.jpg`}));
    await fixture.render({tracks, active:0, playing:false});
    let replacementVisible = false;
    for (let index = 0; index < 160; index++) {
      const frame = fixture.step(40);
      replacementVisible ||= frame.some(draw => draw.cover.startsWith("paused-"));
    }
    assert.ok(replacementVisible, "committing the pending pool must schedule its first frame even after the old settle budget");
    assert.equal(fixture.frameCount(), 0, "the paused replacement finishes and sleeps");
  } finally { await fixture.dispose(); }
});

for (const mode of ["pause", "reduce", "resize", "hide"]) {
  test(`the captured back face survives ${mode} during a turn`, async () => {
    const fixture = await createWallFixture();
    try {
      const turn = fixture.findTurn();
      const back = fixture.findBack(turn);
      let resizedSlot;
      if (mode === "pause") await fixture.render({ playing: false });
      else if (mode === "reduce") await fixture.reduce();
      else if (mode === "resize") resizedSlot = fixture.resize(920, 620, turn.tileIndex);
      else {
        fixture.hide(true);
        fixture.step(20_000);
        fixture.hide(false);
      }
      // Resizing changes slot coordinates but preserves each tile's assignment.
      const landed = mode === "resize" ? fixture.step(800) : fixture.finishTurn(turn, back);
      if (mode === "resize") assert.deepEqual(landed.filter(draw => draw.slot === resizedSlot).map(draw => draw.cover), [back],
        "the same resized tile retains its captured back cover");
      if (mode === "pause" || mode === "reduce") {
        fixture.step(2000);
        assert.equal(fixture.frameCount(), 0, "static canvases stop after landing and the fade tail");
      }
    } finally { await fixture.dispose(); }
  });
}

test("new pools evicting the image cache cannot replace the captured flip surfaces", async () => {
  const fixture = await createWallFixture();
  try {
    const turn = fixture.findTurn();
    const back = fixture.findBack(turn);
    const retainedFront = fixture.decodedImages().find(image => image.src === turn.images[0].cover);
    const retainedBack = fixture.decodedImages().find(image => image.src === back);
    assert.ok(retainedFront && retainedBack, "both flip faces retain the decoded DOM image");
    // Six bounded pools load more surfaces than the 96-entry image cache.
    for (const batch of [1, 2, 3, 4, 5, 6]) {
      const tracks = Array.from({ length: 200 }, (_, index) => ({ id: `${batch}-${index}`, title: "Next", album: `${batch}-${index}`,
        artist: "Next artist", cover_path: `cache-replacement-${batch}-${index}.jpg` }));
      await fixture.render({ tracks });
    }
    fixture.finishTurn(turn, back);
    assert.equal(retainedFront.src, turn.images[0].cover);
    assert.equal(retainedBack.src, back, "cache eviction cannot clear a still-referenced flip source");
  } finally { await fixture.dispose(); }
});

test("pending and failed covers never become the target of a wall flip", async () => {
  const fixture = await createWallFixture({ pending: [1, 2] });
  try {
    for (let index = 0; index < 160; index++) {
      assert.ok(fixture.step(40).every(draw => draw.scaleX === 1), "only one decoded cover cannot turn to an unavailable back face");
    }
    await fixture.load(1);
    await fixture.load(2, false);
    const turn = fixture.findTurn();
    const back = fixture.findBack(turn);
    assert.ok(!back.startsWith("C"), "a failed cover cannot be chosen");
    fixture.finishTurn(turn, back);
  } finally { await fixture.dispose(); }
});

test("a DPI-only change updates perspective beyond the raster cap without restarting the captured turn", async () => {
  const fixture = await createWallFixture({ dpi: 2 });
  try {
    assert.equal(fixture.resolutionListenerCount(), 1, "StrictMode keeps exactly one DPI subscription");
    const turn = fixture.findTurn();
    const back = fixture.findBack(turn);
    let before;
    for (let index = 0; index < 20; index++) {
      before = fixture.step(20).find(draw => draw.slot === turn.slot);
      if (before?.scaleX > 0.3 && before.scaleX < 0.85) break;
    }
    assert.equal(before.cover, back);
    assert.equal(before.quad.length, 4);
    const edgeSkew = draw => Math.abs((draw.quad[2].y - draw.quad[1].y) / (draw.quad[3].y - draw.quad[0].y) - 1);
    const backing = fixture.backingSize();
    fixture.changeDpi(3);
    const after = fixture.step(0).find(draw => draw.slot === turn.slot);
    assert.equal(after.cover, back, "the same back surface remains in flight");
    assert.equal(after.alpha, before.alpha, "the DPI event does not restart the fade clock");
    assert.ok(edgeSkew(after) < edgeSkew(before) * 0.8, "physical focal depth reduces the near/far edge imbalance");
    assert.deepEqual(fixture.backingSize(), backing, "raster memory remains capped at 2x");
    assert.equal(fixture.resolutionListenerCount(), 1, "the next resolution query replaces the old subscription");
    fixture.finishTurn(turn, back);
    await fixture.render({ playing: false });
    fixture.step(2000);
    assert.equal(fixture.frameCount(), 0);
    fixture.changeDpi(1.25);
    fixture.step(2000);
    assert.equal(fixture.frameCount(), 0, "a DPI redraw of a paused wall settles and sleeps");
  } finally {
    await fixture.dispose();
    assert.equal(fixture.resolutionListenerCount(), 0);
    assert.equal(fixture.frameCount(), 0);
  }
});

test("a paused wall resamples the physical light field immediately on DPI change and keeps full overlay strength", async () => {
  const fixture = await createWallFixture({ dpi: 2 });
  try {
    fixture.findTurn();
    await fixture.render({ playing: false });
    fixture.step(4000);
    fixture.step(2000);
    assert.equal(fixture.frameCount(), 0);
    const before = fixture.colorFieldWrites().at(-1);
    const count = fixture.colorFieldWrites().length;
    const backing = fixture.backingSize();
    fixture.changeDpi(3);
    fixture.step(1);
    const after = fixture.colorFieldWrites().at(-1);
    assert.equal(fixture.colorFieldWrites().length, count + 1, "DPI invalidation bypasses the 42 ms update budget");
    assert.notDeepEqual(after.data, before.data, "the new physical distances change the light field");
    assert.deepEqual([after.width, after.height], [before.width, before.height], "the bounded field resolution stays unchanged");
    assert.deepEqual(fixture.backingSize(), backing, "a DPI above 2 does not allocate a larger wall");
    const composite = fixture.colorFieldComposites().at(-1);
    assert.equal(composite.mode, "overlay");
    assert.equal(composite.alpha, 1, "a settled opaque field has no extra fixed attenuation");
    fixture.step(2000);
    assert.equal(fixture.frameCount(), 0);
  } finally { await fixture.dispose(); }
});

let fixtureId = 0;
test("stationary, dissolving and turning covers reuse one native material without touching the color source", async () => {
  const fixture = await createWallFixture();
  try {
    fixture.findTurn();
    const writes = fixture.materialWrites();
    assert.ok(writes.length > 0);
    assert.ok(writes.every(write => write.alpha === 255 && write.gray && write.width <= 384 && write.height <= 384));
    assert.equal(new Set(writes.map(write => write.cover)).size, writes.length, "one material per decoded cover");
    assert.ok(fixture.step().every(draw => draw.material && draw.filter === "none"), "projected and stationary faces use the same flattened material");
    const before = fixture.materialWrites().length;
    for (let index = 0; index < 120; index++) fixture.step(40);
    assert.equal(fixture.materialWrites().length, before, "material pixel work is cached rather than repeated each frame");
    await fixture.render({ active: 1 });
    for (let index = 0; index < 120; index++) fixture.step(40);
    assert.ok(fixture.step().every(draw => draw.material && draw.filter === "none"));
  } finally { await fixture.dispose(); }
});

test("the GPU wall receives raw covers and matches the settled Canvas tile boundaries", async () => {
  const fixture = await createWallFixture({ gpu: true, dpi: 2 });
  try {
    await fixture.render({ playing: false });
    assert.deepEqual(fixture.step(2000), [], "successful GPU output replaces individual 2D cover drawing");
    const frame = fixture.gpu.frames.at(-1);
    assert.equal(fixture.gpu.composites.at(-1), frame);
    assert.deepEqual(frame.size, { width: 1180, height: 760, rasterScale: 2, dpiScale: 2 });
    const tiles = buildCanvasMosaicTiles(1180, 760, []);
    assert.equal(frame.covers.length, tiles.length);
    assert.equal(fixture.materialWrites().length, 0, "the GPU samples original color surfaces rather than flattened material");
    for (let index = 0; index < tiles.length; index++) {
      const tile = tiles[index], cover = frame.covers[index];
      assert.ok(!cover.image.material);
      assert.equal(cover.opacity, 89 / 255);
      assert.equal(cover.backingOpacity, 1);
      const expected = [[tile.x + 1, tile.y + 1], [tile.x + tile.width - 1, tile.y + 1],
        [tile.x + tile.width - 1, tile.y + tile.height - 1], [tile.x + 1, tile.y + tile.height - 1]];
      cover.vertices.forEach((vertex, corner) => {
        assert.ok(Math.abs(vertex.x - expected[corner][0]) < 1e-8,
          "native one-pixel padding preserves a centered, fixed cover face");
        assert.ok(Math.abs(vertex.y - expected[corner][1]) < 1e-8);
        assert.equal(vertex.w, 1);
      });
    }
    fixture.step(2000);
    assert.equal(fixture.frameCount(), 0, "GPU output shares the paused wall's sleep lifecycle");
  } finally {
    await fixture.dispose();
    assert.ok(fixture.gpu.instances.every(instance => instance.disposed), "StrictMode and unmount release every renderer");
  }
});

for (const failure of ["cover", "finish", "begin", "context loss"]) {
  test(`a GPU ${failure} failure redraws the whole current frame once and permanently falls back`, async () => {
    const fixture = await createWallFixture({ gpu: true });
    try {
      await fixture.render({ playing: false });
      fixture.step(2000);
      const coverCount = fixture.gpu.frames.at(-1).covers.length;
      const advanceCount = fixture.advanceCount();
      const composites = fixture.gpu.composites.length;
      if (failure === "cover") fixture.gpu.failCoverAt = 5;
      else if (failure === "finish") fixture.gpu.failFinish = true;
      else if (failure === "begin") fixture.gpu.failBegin = true;
      else fixture.gpu.lost = true;
      await fixture.render({ playing: true });
      const fallback = fixture.step(16);
      assert.equal(fallback.length, coverCount, "tiles before and after the rejected GPU draw all render this frame");
      assert.equal(fixture.advanceCount() - advanceCount, coverCount, "renderer retry must not advance any artwork twice");
      assert.equal(fixture.gpu.composites.length, composites, "a partially rendered GPU target is never presented");
      assert.ok(fallback.every(draw => draw.material && draw.alpha === 1), "the current original cover assignments remain intact");
      assert.equal(fixture.colorFieldComposites().at(-1).mode, "overlay", "the complete fallback includes the light field");
      assert.ok(fixture.gpu.instances.every(instance => instance.disposed));
      const attempts = fixture.gpu.attempts, begins = fixture.gpu.begins, finishes = fixture.gpu.finishes;
      assert.equal(fixture.step(16).length, coverCount);
      assert.deepEqual([fixture.gpu.attempts, fixture.gpu.begins, fixture.gpu.finishes], [attempts, begins, finishes],
        "subsequent frames do not recreate or retry the failing GPU");
      await fixture.render({ playing: false });
      fixture.step(2000);
      assert.equal(fixture.frameCount(), 0);
    } finally { await fixture.dispose(); }
  });
}

test("GPU rejection preserves the same in-flight artwork mix when it redraws on Canvas", async () => {
  const fixture = await createWallFixture({ gpu: true });
  try {
    await fixture.render({ playing: false });
    fixture.step(2000);
    const tracks = ["GPU-new-a", "GPU-new-b", "GPU-new-c"].map(id => ({ id, title: id, album: id, artist: "Next", cover_path: `${id}.jpg` }));
    await fixture.render({ tracks });
    fixture.gpu.failFinish = true;
    const before = fixture.advanceCount();
    const fallback = fixture.step(16);
    const prepared = fixture.gpu.frames.at(-1).covers;
    assert.equal(fixture.advanceCount() - before, prepared.length);
    assert.equal(fallback.length, prepared.length * 2, "each old and new cover retains one dissolve draw");
    for (let index = 0; index < prepared.length; index++) {
      const old = fallback[index * 2], current = fallback[index * 2 + 1], gpu = prepared[index];
      assert.equal(old.cover, gpu.previous.cover);
      assert.equal(current.cover, gpu.image.cover);
      assert.equal(old.alpha, 1);
      assert.equal(current.alpha, gpu.mix, "fallback uses the mix captured before GPU failure");
    }
    fixture.step(2000);
    assert.equal(fixture.frameCount(), 0, "the rejected GPU does not leave a paused dissolve running");
  } finally { await fixture.dispose(); }
});

test("GPU rejection during a back-face fade retains its decoded face and animation clock", async () => {
  const fixture = await createWallFixture({ gpu: true });
  try {
    let turning;
    for (let index = 0; index < 200; index++) {
      fixture.step(40);
      const state = fixture.observedFlip();
      if (state.tileIndex >= 0 && fixture.time() - state.startedAt >= 1600) { turning = state; break; }
    }
    assert.ok(turning, "real playback reaches the partially faded back face");
    const tile = buildCanvasMosaicTiles(1180, 760, [])[turning.tileIndex];
    const slot = `${tile.x + 1},${tile.y + 1},${tile.width - 2},${tile.height - 2}`;
    const back = fixture.gpu.frames.at(-1).covers[turning.tileIndex].image;
    fixture.gpu.failFinish = true;
    const before = fixture.advanceCount();
    const fallback = fixture.step(16).filter(draw => draw.slot === slot);
    const prepared = fixture.gpu.frames.at(-1).covers;
    const gpuFace = prepared[turning.tileIndex];
    assert.equal(gpuFace.image, back);
    assert.ok(gpuFace.opacity > 0 && gpuFace.opacity < 89 / 255);
    assert.deepEqual(fallback.map(draw => draw.cover), [back.cover]);
    assert.equal(fallback[0].alpha, gpuFace.opacity / (89 / 255), "the same quantized alpha is applied once to the flattened fallback");
    assert.equal(fixture.observedFlip().startedAt, turning.startedAt);
    assert.equal(fixture.advanceCount() - before, prepared.length - 1, "the captured turn never enters a replacement dissolve");
    await fixture.render({ playing: false });
    fixture.finishTurn({ slot }, back.cover);
    fixture.step(2000);
    assert.equal(fixture.frameCount(), 0);
  } finally { await fixture.dispose(); }
});

test("the GPU wall keeps bounded decoded images and extracts palette colors through a separate small Canvas", async () => {
  const fixture = await createWallFixture({ gpu: true, imageSize: [384, 192] });
  try {
    fixture.step(2500);
    const covers = fixture.gpu.frames.at(-1).covers;
    assert.ok(covers.length > 0);
    assert.ok(covers.every(cover => fixture.decodedImages().includes(cover.image)));
    assert.ok(covers.every(cover => cover.image.src && cover.image.naturalWidth === 384 && cover.image.naturalHeight === 192));
    assert.deepEqual(covers[0].uv, [{u:.25,v:0},{u:.75,v:0},{u:.75,v:1},{u:.25,v:1}],
      "center crop is computed from decoded source size, not the CSS width=1");
    assert.ok(fixture.imageRasters().every(raster => raster.width <= 48 && raster.height <= 48),
      "a direct GPU cover is never rasterized at full size for upload");
    const first = covers[0].image;
    fixture.step(80);
    assert.equal(fixture.gpu.frames.at(-1).covers[0].image, first);
    assert.equal(first.src, first.originalPath);
  } finally { await fixture.dispose(); }
});

test("oversized wall covers downsample within 384 pixels, release the original and retain Canvas fallback rendering", async () => {
  const fixture = await createWallFixture({ gpu: true, imageSize: [768, 192] });
  try {
    fixture.step(2500);
    const covers = fixture.gpu.frames.at(-1).covers;
    assert.ok(covers.length > 0);
    assert.ok(covers.every(cover => cover.image instanceof window.HTMLCanvasElement && cover.image.width === 384 && cover.image.height === 96));
    assert.ok(fixture.decodedImages().every(image => image.src === ""));
    fixture.gpu.failFinish = true;
    const fallback = fixture.step(40);
    assert.ok(fallback.length > 0 && fallback.every(draw => draw.material));
    assert.ok(fixture.materialWrites().every(write => write.width <= 384 && write.height <= 384));
  } finally { await fixture.dispose(); }
});

test("a failed oversized wall raster releases its source and leaves the grid without invalid GPU covers", async () => {
  const fixture = await createWallFixture({ gpu: true, imageSize: [768, 192], rasterFailure: true });
  try {
    fixture.step(2500);
    assert.ok(fixture.decodedImages().every(image => image.src === ""));
    assert.equal(fixture.gpu.frames.at(-1).covers.length, 0);
  } finally { await fixture.dispose(); }
});

async function createWallFixture({ pending = [], dpi = 1, gpu = false, imageSize = [256, 256], rasterFailure = false } = {}) {
  const dom = new JSDOM('<body><div id="root"></div></body>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.__TAURI_INTERNALS__ = { convertFileSrc: path => path };
  const gpuFixture = { enabled: gpu, failCreate: false, failBegin: false, failFinish: false,
    failCoverAt: null, lost: false, attempts: 0, begins: 0, finishes: 0, frames: [], instances: [], composites: [] };
  window.__mosaicGpuFixture = gpuFixture;
  window.__mosaicAdvanceCalls = 0;
  const frames = new Map();
  let nextId = 0;
  const realPerformance = globalThis.performance;
  let now = 1000;
  globalThis.performance = { now: () => now };
  let resize;
  let draws = [];
  const colorFieldWrites = [], colorFieldComposites = [];
  const materialWrites = [];
  let width = 1180, height = 760;
  let hidden = false;
  const imageResolvers = new Map();
  const decodedImages = [], imageRasters = [];
  let tracks = ["A", "B", "C"].map(id => ({ id, title: id, album: id, artist: "Artist", cover_path: `${id}-${++fixtureId}.jpg` }));
  const pendingPaths = new Set(pending.map(index => tracks[index].cover_path));
  const mediaListeners = new Set();
  const media = { matches: false, addEventListener: (_event, listener) => mediaListeners.add(listener),
    removeEventListener: (_event, listener) => mediaListeners.delete(listener) };
  const resolutionListeners = new Set();
  const resolution = { addEventListener: (_event, listener) => resolutionListeners.add(listener),
    removeEventListener: (_event, listener) => resolutionListeners.delete(listener) };
  window.devicePixelRatio = dpi;
  Object.defineProperty(document, "hidden", { get: () => hidden });
  window.requestAnimationFrame = callback => { frames.set(++nextId, callback); return nextId; };
  window.cancelAnimationFrame = id => frames.delete(id);
  window.matchMedia = query => query.includes("resolution:") ? resolution : media;
  globalThis.ResizeObserver = class { constructor(callback) { resize = callback; } observe() {} disconnect() {} };
  globalThis.Image = class {
    constructor() { decodedImages.push(this); }
    complete = true;
    naturalWidth = imageSize[0];
    naturalHeight = imageSize[1];
    width = 1;
    height = 1;
    set src(value) { this.source = value; if (value) this.originalPath = value; }
    get src() { return this.source; }
    get cover() { return this.src; }
    decode() {
      if (!pendingPaths.has(this.src)) return Promise.resolve();
      return new Promise((resolve, reject) => imageResolvers.set(this.src, ready => ready ? resolve() : reject()));
    }
    addEventListener() {}
    removeEventListener() {}
  };
  dom.window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ width, height });
  const contexts = new WeakMap();
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    if (rasterFailure && this.className !== "now-mosaic-canvas") return null;
    if (contexts.has(this)) return contexts.get(this);
    let slot;
    let scaleX = 1;
    let path = [];
    const stack = [];
    const canvas = this;
    const gradient = { addColorStop() {} };
    const context = {
      globalAlpha: 1,
      save() { stack.push([this.globalAlpha, slot, scaleX, path]); },
      restore() { [this.globalAlpha, slot, scaleX, path] = stack.pop(); },
      setTransform() {}, translate() {}, clearRect() { canvas.projectedScaleX = 1; }, fillRect() {}, beginPath() { path = []; }, clip() {}, strokeRect() {},
      fill() {}, moveTo(x, y) { path.push({ x, y }); }, lineTo(x, y) { path.push({ x, y }); }, closePath() {},
      transform(a, b, c, d) { scaleX = Math.abs(a / d); },
      scale(x, y) { scaleX = x / y; },
      rect(x, y, width, height) { slot = `${x},${y},${width},${height}`; },
      createLinearGradient() { return gradient; }, createRadialGradient() { return gradient; },
      createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
      putImageData(data) {
        if (canvas.width === 112) colorFieldWrites.push({ width: canvas.width, height: canvas.height, data: [...data.data] });
        else if (canvas.cover) {
          canvas.material = true;
          materialWrites.push({cover:canvas.cover, width:canvas.width,height:canvas.height,alpha:data.data[3],gray:data.data[0]===data.data[1]&&data.data[1]===data.data[2]});
        }
      },
      getImageData() { return { data: new Uint8ClampedArray(48 * 48 * 4) }; },
      drawImage(image) {
        if (canvas.className === "now-mosaic-canvas" && image.gpuWall) gpuFixture.composites.push(image.frame);
        if (canvas.className === "now-mosaic-canvas" && image.width === 112)
          colorFieldComposites.push({ alpha: this.globalAlpha, mode: this.globalCompositeOperation });
        if (image instanceof globalThis.Image) { canvas.cover = image.src; imageRasters.push({source:image,width:canvas.width,height:canvas.height}); }
        else if (canvas.className !== "now-mosaic-canvas" && image.cover) {
          canvas.cover = image.cover;
          canvas.material = image.material;
          canvas.projectedScaleX = Math.min(canvas.projectedScaleX ?? 1, scaleX);
        }
        else if (canvas.className === "now-mosaic-canvas" && image.cover) {
          draws.push({ slot, cover: image.cover, alpha: this.globalAlpha, scaleX: image.projectedScaleX ?? scaleX, quad: [...path], material:image.material, filter:this.filter ?? "none" });
        }
      },
    };
    contexts.set(this, context);
    return context;
  };
  const root = createRoot(document.getElementById("root"));
  let active = 0, playing = true;
  const render = async (changes = {}) => act(async () => {
    active = changes.active ?? active;
    playing = changes.playing ?? playing;
    tracks = changes.tracks ?? tracks;
    root.render(React.createElement(React.StrictMode, null,
      React.createElement(NowPlayingMosaicCanvas, { tracks, activeTrack: tracks[active], isPlaying: playing })));
    await new Promise(resolve => setImmediate(resolve));
  });
  await render();
  const step = (ms = 16) => {
    now += ms;
    draws = [];
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(now));
    // A projected face is textured by sixteen triangles. Retain distinct faces
    // and alpha values so duplicate triangles cannot hide a second cover.
    const faces = new Map();
    for (const draw of draws) {
      const key = `${draw.slot}\0${draw.cover}\0${draw.alpha}`;
      const face = faces.get(key);
      if (face) { face.scaleX = Math.min(face.scaleX, draw.scaleX); face.triangles++; }
      else faces.set(key, { ...draw, triangles: 1 });
    }
    return [...faces.values()];
  };
  return {
    step, render, frameCount: () => frames.size,
    colorFieldWrites: () => colorFieldWrites, colorFieldComposites: () => colorFieldComposites,
    materialWrites: () => materialWrites,
    decodedImages: () => decodedImages, imageRasters: () => imageRasters,
    gpu: gpuFixture,
    advanceCount: () => window.__mosaicAdvanceCalls,
    observedFlip: () => ({ ...window.__mosaicObservedFlip }),
    time: () => now,
    resolutionListenerCount: () => resolutionListeners.size,
    backingSize: () => { const canvas = document.querySelector(".now-mosaic-canvas"); return [canvas.width, canvas.height]; },
    changeDpi(value) {
      window.devicePixelRatio = value;
      [...resolutionListeners].forEach(listener => listener());
    },
    resize(nextWidth = width, nextHeight = height, tileIndex) {
      const oldId = tileIndex === undefined ? null : buildCanvasMosaicTiles(width, height, [])[tileIndex].id;
      width = nextWidth; height = nextHeight; resize();
      if (tileIndex === undefined) return;
      const tile = buildCanvasMosaicTiles(width, height, []).find(tile => tile.id === oldId);
      assert.ok(tile, "the selected square stays in the resized viewport");
      return `${tile.x + 1},${tile.y + 1},${tile.width - 2},${tile.height - 2}`;
    },
    reduce: async () => act(async () => { media.matches = true; mediaListeners.forEach(listener => listener()); }),
    hide(value) { hidden = value; document.dispatchEvent(new window.Event("visibilitychange")); },
    load: async (index, ready = true) => act(async () => {
      imageResolvers.get(tracks[index].cover_path)?.(ready);
      await new Promise(resolve => setImmediate(resolve));
    }),
    findTurn() {
      for (let stepIndex = 0; stepIndex < 140; stepIndex++) {
        const frame = step(40);
        const turning = frame.find(draw => draw.scaleX < 0.98);
        if (turning) return { slot: turning.slot, tileIndex: frame.indexOf(turning), images: frame.filter(draw => draw.slot === turning.slot) };
      }
      assert.fail("the playing wall should begin a cover turn");
    },
    findBack(turn) {
      for (let index = 0; index < 50; index++) {
        const tile = step(20).filter(draw => draw.slot === turn.slot);
        if (tile[0]?.cover !== turn.images[0].cover) return tile[0].cover;
      }
      assert.fail("a decoded back face should appear at the apex");
    },
    finishTurn(turn, back) {
      for (let index = 0; index < 80; index++) {
        const tile = step(40).filter(draw => draw.slot === turn.slot);
        assert.deepEqual(tile.map(draw => draw.cover), [back], "a captured back face cannot be overwritten during landing");
        // COLOR0 can quantize to its final byte before the animation's clock
        // reaches its tail. Observe the real state update before retiring it.
        if (tile[0].scaleX === 1 && tile[0].alpha === 1 && window.__mosaicObservedFlip.tileIndex < 0) return tile;
      }
      assert.fail("the turn should finish");
    },
    async dispose() {
      await act(async () => { root.unmount(); imageResolvers.forEach(resolve => resolve(false));
        await new Promise(resolve => setImmediate(resolve)); });
      dom.window.close();
      globalThis.performance = realPerformance;
    },
  };
}
