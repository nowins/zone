import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

await build({ stdin: { contents: `export { NowPlayingMosaicCanvas } from './src/components/NowPlayingMosaicCanvas';
export { buildCanvasMosaicTiles } from './src/utils/nowPlayingCanvas';`, resolveDir: process.cwd(), loader: "ts" },
  outfile: ".tmp/mosaic-render-tests/runtime.js", bundle: true, packages: "external", format: "esm", platform: "browser",
  define: { "import.meta.env.DEV": "false" }, logLevel: "silent" });
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
    // Six bounded pools load more surfaces than the 96-entry image cache.
    for (const batch of [1, 2, 3, 4, 5, 6]) {
      const tracks = Array.from({ length: 200 }, (_, index) => ({ id: `${batch}-${index}`, title: "Next", album: `${batch}-${index}`,
        artist: "Next artist", cover_path: `cache-replacement-${batch}-${index}.jpg` }));
      await fixture.render({ tracks });
    }
    fixture.finishTurn(turn, back);
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
async function createWallFixture({ pending = [], dpi = 1 } = {}) {
  const dom = new JSDOM('<body><div id="root"></div></body>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.__TAURI_INTERNALS__ = { convertFileSrc: path => path };
  const frames = new Map();
  let nextId = 0;
  const realPerformance = globalThis.performance;
  let now = 1000;
  globalThis.performance = { now: () => now };
  let resize;
  let draws = [];
  const colorFieldWrites = [], colorFieldComposites = [];
  let width = 1180, height = 760;
  let hidden = false;
  const imageResolvers = new Map();
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
    complete = true;
    naturalWidth = 256;
    naturalHeight = 256;
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
      },
      getImageData() { return { data: new Uint8ClampedArray(48 * 48 * 4) }; },
      drawImage(image) {
        if (canvas.className === "now-mosaic-canvas" && image.width === 112)
          colorFieldComposites.push({ alpha: this.globalAlpha, mode: this.globalCompositeOperation });
        if (image instanceof globalThis.Image) canvas.cover = image.src;
        else if (canvas.className !== "now-mosaic-canvas" && image.cover) {
          canvas.cover = image.cover;
          canvas.projectedScaleX = Math.min(canvas.projectedScaleX ?? 1, scaleX);
        }
        else if (canvas.className === "now-mosaic-canvas" && image.cover) {
          draws.push({ slot, cover: image.cover, alpha: this.globalAlpha, scaleX: image.projectedScaleX ?? scaleX, quad: [...path] });
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
      return `${tile.x},${tile.y},${tile.width - 1},${tile.height - 1}`;
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
        if (tile[0].scaleX === 1 && tile[0].alpha === 1) return tile;
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
