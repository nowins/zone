import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { TILE_MOTION } from "../.tmp/visualizer-tests/motion/tokens.js";

await build({ stdin: { contents: `export { QuickplayPinBoard } from './src/components/tiles/QuickplayPinBoard';
export { FlipTile } from './src/components/tiles/FlipTile';
export { MosaicFrames } from './src/components/tiles/MosaicTile';
export { _setAnimationClockForTesting } from './src/motion/animate';`, resolveDir: process.cwd(), loader: "tsx" },
  outfile: ".tmp/tile-tests/runtime.js", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { QuickplayPinBoard, FlipTile, MosaicFrames, _setAnimationClockForTesting } = await import("../.tmp/tile-tests/runtime.js");

function environment() {
  const dom = new JSDOM('<body><div id="root"></div></body>');
  for (const key of ["window", "document", "Node", "Element", "HTMLElement", "getComputedStyle"]) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let now = 0, id = 0, hidden = false;
  Object.defineProperty(window.performance, "now", { value: () => now });
  const timers = new Map(), frames = [], observers = new Set(), listeners = new Set();
  const media = { matches: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  window.matchMedia = () => media;
  Object.defineProperty(document, "hidden", { get: () => hidden });
  window.setTimeout = (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; };
  window.clearTimeout = key => timers.delete(key);
  globalThis.IntersectionObserver = class {
    constructor(fn) { this.fn = fn; observers.add(this); }
    observe(element) { this.element = element; }
    disconnect() { observers.delete(this); }
  };
  _setAnimationClockForTesting(() => now, fn => frames.push(fn));
  const root = createRoot(document.getElementById("root"));
  return { root, timers, observers, frames, now: () => now,
    render: async element => act(async () => root.render(React.createElement(React.StrictMode, null, element))),
    intersect: async visible => act(async () => observers.forEach(o => o.fn([{ isIntersecting: visible }]))),
    hide: async value => act(async () => { hidden = value; document.dispatchEvent(new window.Event("visibilitychange")); }),
    reduce: async value => act(async () => { media.matches = value; listeners.forEach(fn => fn()); }),
    advance: async ms => act(async () => {
      const end = now + ms;
      while (now < end) {
        now = Math.min(now + 16, end);
        for (const [key, timer] of timers) if (timer.at <= now) { timers.delete(key); timer.fn(); }
        const pending = frames.splice(0); pending.forEach(fn => fn(now));
      }
    }),
    cleanup: async () => { await act(async () => root.unmount()); assert.equal(timers.size, 0); assert.equal(observers.size, 0); dom.window.close(); },
  };
}

for (const variant of ["flip", "peek"]) test(`${variant} live content dwells, sleeps and resumes after the edit host changes`, async () => {
  const env = environment();
  const render = async paused => env.render(React.createElement(FlipTile, { variant, paused, asButton: !paused, front: "正面", back: "更新内容" }));
  try {
    await render(false);
    assert.equal(env.timers.size, 0, "offscreen tiles schedule no ambient work");
    await env.intersect(true);
    const first = [...env.timers.values()][0].at;
    await env.advance(first + (variant === "peek" ? TILE_MOTION.peek : TILE_MOTION.flipHalf * 2) + 80);
    assert.ok(document.querySelector(".tile.is-back"), "first visible update arrives");
    await env.advance(3000);
    assert.ok(document.querySelector(".tile.is-back"), "information remains readable during its dwell");
    await env.hide(true);
    assert.equal(env.timers.size, 0);
    assert.ok(document.querySelector(".tile.is-front"));
    await env.hide(false);
    assert.equal(env.timers.size, 1);
    await render(true);
    assert.equal(env.timers.size, 0, "editing cancels pending cycles");
    await render(false);
    await env.intersect(true);
    assert.equal(env.timers.size, 1, "new button host gets a fresh observer");
    const tile = document.querySelector(".tile");
    await act(async () => tile.dispatchEvent(new window.Event("pointerenter")));
    assert.equal(env.timers.size, 0);
    await act(async () => tile.dispatchEvent(new window.Event("pointerleave")));
    assert.equal(env.timers.size, 1);
    await env.reduce(true);
    assert.equal(env.timers.size, 0, "reduced motion stops automatic flips completely");
    await env.intersect(false);
    await env.reduce(false);
    assert.equal(env.timers.size, 0);
  } finally { await env.cleanup(); }
});

for (const variant of ["flip", "peek"]) {
  test(`${variant} retains its displayed face on hover and focus, then resumes its remaining dwell`, async () => {
    const env = environment();
    const duration = variant === "peek" ? TILE_MOTION.peek : TILE_MOTION.flipHalf * 2;
    const dispatch = async (tile, type) => act(async () => tile.dispatchEvent(new window.Event(type)));
    try {
      await env.render(React.createElement(FlipTile, { variant, front: "正面", back: "信息" }));
      await env.intersect(true);
      const first = [...env.timers.values()][0].at;
      await env.advance(first + duration + 80);
      const tile = document.querySelector(".tile");
      await env.advance(1000);
      await dispatch(tile, "pointerenter");
      assert.ok(tile.classList.contains("is-back"), "hover must not reset the displayed information");
      assert.equal(env.timers.size, 0, "the dwell sleeps during interaction");
      await env.advance(30_000);
      assert.ok(tile.classList.contains("is-back"));
      assert.equal(env.frames.length, 0, "holding a face does not spin animation frames");
      await act(async () => tile.focus());
      await dispatch(tile, "pointerleave");
      assert.equal(env.timers.size, 0, "keyboard focus continues the hold after the pointer leaves");
      await act(async () => tile.blur());
      assert.equal(env.timers.size, 1);
      await env.advance(TILE_MOTION.hold - 1200);
      assert.ok(tile.classList.contains("is-back"), "remaining dwell is preserved");
      await env.advance(400 + duration);
      assert.ok(tile.classList.contains("is-front"), "leaving resumes a normal animated return");
      assert.equal(env.timers.size, 1, "only one future cycle is queued");
    } finally { await env.cleanup(); }
  });

  test(`${variant} completes an in-flight reveal on hover and resets only on visibility or motion changes`, async () => {
    const env = environment();
    const duration = variant === "peek" ? TILE_MOTION.peek : TILE_MOTION.flipHalf * 2;
    try {
      await env.render(React.createElement(FlipTile, { variant, front: "正面", back: "信息" }));
      await env.intersect(true);
      const first = [...env.timers.values()][0].at;
      await env.advance(first + 120);
      const tile = document.querySelector(".tile"), surface = document.querySelector(".tile-flip-surface");
      const back = document.querySelector(".tile-face-back");
      const pose = () => variant === "peek" ? back.style.getPropertyValue("--tile-peek") : surface.style.getPropertyValue("--tile-flip");
      const midway = pose();
      await act(async () => tile.dispatchEvent(new window.Event("pointerenter")));
      assert.equal(pose(), midway, "entering does not jump from the current frame");
      await env.advance(duration + TILE_MOTION.hold);
      assert.ok(tile.classList.contains("is-back"), "the reveal settles before holding");
      assert.equal(env.timers.size, 0);
      await env.intersect(false);
      assert.ok(tile.classList.contains("is-front"));
      await act(async () => tile.dispatchEvent(new window.Event("pointerleave")));
      await env.intersect(true);
      const next = [...env.timers.values()][0].at;
      await env.advance(next - env.now() + duration + 80);
      await act(async () => tile.dispatchEvent(new window.Event("pointerenter")));
      assert.ok(tile.classList.contains("is-back"));
      await env.reduce(true);
      assert.ok(tile.classList.contains("is-front"), "reduced motion parks both faces");
      assert.equal(env.timers.size, 0);
    } finally { await env.cleanup(); }
  });

  test(`${variant} finishes an in-flight return without a hover snap or a new cycle`, async () => {
    const env = environment();
    const duration = variant === "peek" ? TILE_MOTION.peek : TILE_MOTION.flipHalf * 2;
    try {
      await env.render(React.createElement(FlipTile, { variant, front: "正面", back: "信息" }));
      await env.intersect(true);
      const first = [...env.timers.values()][0].at;
      await env.advance(first + duration + TILE_MOTION.hold + 120);
      const tile = document.querySelector(".tile"), surface = document.querySelector(".tile-flip-surface");
      const back = document.querySelector(".tile-face-back");
      const pose = () => variant === "peek" ? back.style.getPropertyValue("--tile-peek") : surface.style.getPropertyValue("--tile-flip");
      const midway = pose();
      await act(async () => tile.dispatchEvent(new window.Event("pointerenter")));
      assert.equal(pose(), midway, "hover does not snap an ongoing return");
      await env.advance(duration + 100);
      assert.ok(tile.classList.contains("is-front"));
      assert.equal(env.timers.size, 0, "no new update begins while handling the tile");
    } finally { await env.cleanup(); }
  });
}

test("peek carries both panels through the same offset and parks both on interruption", async () => {
  const env = environment();
  try {
    await env.render(React.createElement(FlipTile, { variant: "peek", front: "封面", back: "内容" }));
    await env.intersect(true);
    const first = [...env.timers.values()][0].at;
    await env.advance(first + 320);
    const front = document.querySelector(".tile-face-front"), back = document.querySelector(".tile-face-back");
    const outgoing = Number.parseFloat(front.style.getPropertyValue("--tile-peek-front"));
    const incoming = Number.parseFloat(back.style.getPropertyValue("--tile-peek"));
    assert.ok(outgoing < 0 && outgoing > -100);
    assert.ok(Math.abs(incoming - outgoing - 100) < 0.02, "the two edges stay joined during the slide");
    await env.hide(true);
    assert.equal(front.style.getPropertyValue("--tile-peek-front"), "0.00%");
    assert.equal(back.style.getPropertyValue("--tile-peek"), "100.00%");
  } finally { await env.cleanup(); }
});

test("mosaic cells stop in edit mode, offscreen and under reduced motion", async () => {
  const env = environment();
  const pool = Array.from({ length: 9 }, (_, i) => React.createElement("span", { key: i }, i));
  const render = async paused => env.render(React.createElement(MosaicFrames, { pool, paused }));
  try {
    await render(false); await env.intersect(true);
    assert.equal(env.timers.size, 1);
    await render(true);
    assert.equal(env.timers.size, 0);
    await render(false);
    assert.equal(env.timers.size, 1);
    await env.intersect(false);
    assert.equal(env.timers.size, 0);
    await env.intersect(true); await env.reduce(true);
    assert.equal(env.timers.size, 0);
  } finally { await env.cleanup(); }
});

test("a mosaic cell keeps the cover revealed at its apex after completion and interaction", async () => {
  const env = environment();
  const random = Math.random;
  Math.random = () => 0;
  const pool = Array.from({ length: 9 }, (_, i) => React.createElement("span", { key: i }, i));
  try {
    await env.render(React.createElement(MosaicFrames, { pool }));
    await env.intersect(true);
    const first = [...env.timers.values()][0].at;
    await env.advance(first + TILE_MOTION.cellHalf + 40);
    const cell = document.querySelector(".tile-mosaic-cell-inner");
    const back = cell.textContent;
    assert.equal(back, "8", "the spare cover is assigned while the cell is edge-on");
    await env.advance(TILE_MOTION.cellHalf + 40);
    assert.equal(cell.textContent, back, "completion keeps the revealed cover");
    await act(async () => document.querySelector(".tile-mosaic").dispatchEvent(new window.Event("pointerenter")));
    assert.equal(cell.textContent, back, "hover keeps the revealed cover");
    await env.reduce(true);
    assert.equal(cell.textContent, back, "reduced motion keeps the revealed cover");
    await env.render(React.createElement(MosaicFrames, { pool: [...pool], paused: true }));
    assert.equal(cell.textContent, back, "entering edit mode does not restore the original cover");
  } finally { Math.random = random; await env.cleanup(); }
});

test("tile arrival runs only for first entry and never replays after restoration or reduced motion", async () => {
  const env = environment();
  const items = [{ pin: { id: "one", kind: "track", targetId: "one", createdAt: 0 }, title: "歌曲",
    subtitle: "艺术家", tracks: [], artPaths: [], payload: null, size: "medium", isSmart: false, liveLine: "" }];
  const props = { items, onActivate() {}, onOpenCollection() {}, onContextMenu() {}, onUnpin() {}, onMovePin() {},
    onResizePin() {}, onShiftPin() {}, onCustomizePin() {} };
  const render = animateEntrance => env.render(React.createElement(QuickplayPinBoard, { ...props, animateEntrance }));
  try {
    await render(true);
    assert.ok(document.querySelector(".tiles-enter"), "StrictMode retains one initial arrival");
    await env.reduce(true);
    assert.equal(document.querySelector(".tiles-enter"), null);
    await env.reduce(false);
    assert.equal(document.querySelector(".tiles-enter"), null, "disabling reduced motion does not replay arrival");
    await render(false);
    assert.equal(document.querySelector(".tiles-enter"), null);
    await env.advance(1000);
    assert.equal(env.timers.size, 0, "a restored board schedules no entrance timer");
  } finally { await env.cleanup(); }
});

test("long press selects a tile without playing, keyboard editing and appearance keep their meaning", async () => {
  const env = environment();
  let activated = 0, resized, shifted, saved;
  const items = ["one", "two"].map(id => ({ pin: { id, kind: "track", targetId: id, createdAt: 0 }, title: id,
    subtitle: "艺术家", tracks: [], artPaths: [], payload: null, size: "medium", isSmart: false, liveLine: "今天听过" }));
  const props = { items, onActivate: () => activated++, onOpenCollection() {}, onContextMenu() {}, onUnpin() {}, onMovePin() {},
    onResizePin: (...args) => { resized = args; }, onShiftPin: (...args) => { shifted = args; }, onCustomizePin: (...args) => { saved = args; } };
  const click = async element => act(async () => element.click());
  const key = async (element, key, altKey = false) => act(async () => element.dispatchEvent(new window.KeyboardEvent("keydown", { key, altKey, bubbles: true })));
  try {
    await env.render(React.createElement(QuickplayPinBoard, props));
    const pin = document.querySelector('[data-pin-id="two"]');
    const down = new window.MouseEvent("pointerdown", { button: 0, clientX: 10, clientY: 10, bubbles: true });
    await act(async () => pin.dispatchEvent(down));
    await env.advance(560);
    assert.ok(pin.classList.contains("selected"));
    assert.equal(document.activeElement, pin, "focus follows the button-to-article change");
    await act(async () => document.querySelector(".quick-pins-grid").dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, clientX: 10, clientY: 10 })));
    await click(pin);
    assert.equal(activated, 0, "the trailing long-press click must not play");
    assert.equal(document.querySelectorAll(".quick-pin-edit-tools").length, 1);
    await key(pin, "ArrowDown", true);
    assert.deepEqual(resized, ["two", "small"]);
    await key(pin, "ArrowLeft", true);
    assert.deepEqual(shifted, ["two", -1]);
    let transportKeys = 0;
    window.addEventListener("keydown", () => transportKeys++);
    await key(pin, "ArrowLeft");
    assert.equal(document.activeElement.dataset.pinId, "one");
    await key(document.activeElement, "ArrowRight");
    assert.equal(document.activeElement.dataset.pinId, "two");
    await key(pin, " ");
    assert.equal(transportKeys, 0, "editing owns selection and activation keys");
    assert.ok(document.querySelector('[role="dialog"]'));
    await click(document.querySelector('[name="pin-size"][value="small"]'));
    await click(document.querySelector('[name="pin-tone"][value="teal"]'));
    await click(document.querySelector('.pin-live-choice input'));
    await act(async () => document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    assert.deepEqual(saved, ["two", { size: "small", tone: "teal", live: false }]);
    await act(async () => new Promise(resolve => setTimeout(resolve, 200)));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await key(pin, "Escape");
    assert.equal(document.querySelector(".quick-pins-grid.editing"), null);
    assert.equal(document.activeElement.className.includes("quick-pins-edit"), true);
    await click(document.querySelector('[data-pin-id="two"] button.tile'));
    assert.equal(activated, 1, "ordinary activation is restored after finishing edit");
  } finally { await env.cleanup(); }
});

test("pointer reordering commits only on an inside release and cancels cleanly", async () => {
  const env = environment();
  const moves = [];
  const items = ["one", "two"].map(id => ({ pin: { id, kind: "track", targetId: id, createdAt: 0 }, title: id,
    subtitle: "艺术家", tracks: [], artPaths: [], payload: null, size: "medium", isSmart: false, liveLine: "今天听过" }));
  const props = { items, onActivate() {}, onOpenCollection() {}, onContextMenu() {}, onUnpin() {}, onResizePin() {}, onShiftPin() {}, onCustomizePin() {},
    onMovePin: (...args) => moves.push(args) };
  const rect = (top, height) => ({ left: 0, right: 100, top, bottom: top + height, width: 100, height });
  let grid, source, target;
  const pointer = async (element, type, y) => act(async () => element.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: y })));
  const start = async () => { await pointer(source, "pointerdown", 20); await pointer(grid, "pointermove", 170); };
  try {
    await env.render(React.createElement(QuickplayPinBoard, props));
    await act(async () => document.querySelector(".quick-pins-edit").click());
    grid = document.querySelector(".quick-pins-grid");
    source = grid.querySelector('[data-pin-id="one"]');
    target = grid.querySelector('[data-pin-id="two"]');
    grid.getBoundingClientRect = () => rect(0, 300);
    Object.assign(grid.style, { gridTemplateRows: "50px 50px 50px 50px 50px 50px", gridAutoColumns: "50px" });
    source.getBoundingClientRect = () => rect(0, 100);
    target.getBoundingClientRect = () => rect(100, 100);
    document.elementFromPoint = () => target;
    await start();
    assert.ok(document.querySelector(".quick-pin-drag-ghost"));
    assert.equal(moves.length, 0, "preview must not write persistent order");
    document.querySelector(".quick-pin-drag-ghost").getBoundingClientRect = () => ({ ...rect(170, 100), left: 30, right: 130 });
    await pointer(grid, "pointerup", 180);
    assert.deepEqual(moves, [["one", "two", true]]);
    assert.equal(document.querySelector(".quick-pin-drag-ghost"), null);
    assert.ok(source.style.transform.includes("translate(30px, 170px)"), "the real tile starts at the released ghost position");
    await env.advance(100);
    assert.notEqual(source.style.transform, "", "landing remains continuous after release");
    await env.advance(TILE_MOTION.settle);
    assert.equal(source.style.transform, "", "landing clears its transient transform");

    for (const reason of ["escape", "outside", "cancel", "blur"]) {
      await start();
      if (reason === "escape") await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      else if (reason === "blur") await act(async () => window.dispatchEvent(new window.Event("blur")));
      else await pointer(grid, reason === "outside" ? "pointerup" : "pointercancel", 500);
      assert.equal(document.querySelector(".quick-pin-drag-ghost"), null, reason);
      assert.equal(document.querySelector(".quick-pin.dragging"), null, reason);
      assert.equal(moves.length, 1, `${reason} must not commit`);
      assert.ok(grid.classList.contains("editing"), "cancelling a drag keeps editing available");
    }
    await start();
  } finally { await env.cleanup(); }
  assert.equal(document.querySelector(".quick-pin-drag-ghost"), null, "unmount removes the floating preview");
});

test("a wall of live tiles and mosaics never updates in lockstep, even with identical random delays", async () => {
  const env = environment();
  const random = Math.random;
  Math.random = () => 0;
  const pool = Array.from({ length: 9 }, (_, i) => React.createElement("span", { key: i }, i));
  try {
    await env.render(React.createElement("div", null,
      ...Array.from({ length: 6 }, (_, key) => React.createElement(FlipTile, { key, variant: "peek", front: "正面", back: "更新" })),
      React.createElement(MosaicFrames, { pool })));
    await env.intersect(true);
    assert.equal(env.timers.size, 1, "one shared wakeup serves all pending tiles");
    await env.advance(17_000);
    assert.equal(document.querySelectorAll(".is-back").length, 0, "the initial wall rests");
    let previous = null, reveals = 0;
    for (let i = 0; i < 240; i++) {
      await env.advance(500);
      const back = document.querySelectorAll(".tile.is-back");
      assert.ok(back.length <= 1, "a readable dwell never overlaps another tile");
      const moving = [...document.querySelectorAll(".tile-face-back")].filter(el => !["", "100.00%"].includes(el.style.getPropertyValue("--tile-peek")));
      const mosaicMoving = [...document.querySelectorAll(".tile-mosaic-cell-inner")].some(el => el.style.willChange === "transform");
      assert.ok(!(back.length && mosaicMoving), "cover replacement shares the reveal queue");
      assert.ok(moving.length + Number(mosaicMoving) <= 1, "reveal and return animations never overlap another tile");
      const current = back[0] ?? null;
      if (current && current !== previous) reveals++;
      previous = current;
    }
    assert.ok(reveals >= 6, "the queue makes progress for the whole wall");
    await env.hide(true);
    assert.equal(env.timers.size, 0, "hiding cancels queued and running work");
    await env.hide(false);
    await env.advance(17_000);
    assert.equal(document.querySelectorAll(".is-back").length, 0, "resuming does not replay a short initial burst");
  } finally { Math.random = random; await env.cleanup(); }
});

test("pointer dragging into an empty lower-left slot previews, commits and can return to its starting position", async () => {
  const env = environment();
  const moves = [];
  const items = ["artist", "album", "mosaic", "podcast", "drag"].map((id, index) => ({
    pin: { id, kind: "track", targetId: id, createdAt: 0 }, title: id, subtitle: "艺术家", tracks: [], artPaths: [],
    payload: null, size: index === 2 ? "large" : "wide", isSmart: false, liveLine: "今天听过",
  }));
  const props = { items, animateEntrance: false, onActivate() {}, onOpenCollection() {}, onContextMenu() {}, onUnpin() {},
    onResizePin() {}, onShiftPin() {}, onCustomizePin() {}, onMovePin: (...args) => moves.push(args) };
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const pointer = async (element, type, x, y) => act(async () => element.dispatchEvent(new window.MouseEvent(type,
    { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })));
  try {
    await env.render(React.createElement(QuickplayPinBoard, props));
    await act(async () => document.querySelector(".quick-pins-edit").click());
    const grid = document.querySelector(".quick-pins-grid");
    Object.assign(grid.style, { gridTemplateRows: "50px 50px 50px 50px 50px 50px", gridAutoColumns: "50px" });
    grid.getBoundingClientRect = () => rect(0, 0, 600, 300);
    const positions = [[0, 0], [0, 100], [200, 0], [200, 200], [400, 0]];
    [...grid.children].forEach((element, index) => { element.getBoundingClientRect = () => rect(...positions[index], 200, index === 2 ? 200 : 100); });
    const source = grid.querySelector('[data-pin-id="drag"]');
    await pointer(source, "pointerdown", 500, 50);
    await pointer(grid, "pointermove", 100, 250);
    assert.deepEqual([...grid.children].map(el => el.dataset.pinId), ["artist", "album", "drag", "mosaic", "podcast"]);
    assert.equal(moves.length, 0);
    await pointer(grid, "pointerup", 100, 250);
    assert.deepEqual(moves, [["drag", "mosaic", false]], "empty slot saves its actual insertion");
    assert.equal(document.activeElement, source);
    await pointer(source, "pointerdown", 500, 50);
    await pointer(grid, "pointermove", 100, 250);
    await pointer(grid, "pointermove", 500, 50);
    assert.deepEqual([...grid.children].map(el => el.dataset.pinId), items.map(item => item.pin.id));
    await pointer(grid, "pointerup", 500, 50);
    assert.equal(moves.length, 1, "returning to the start does not write another order");
  } finally { await env.cleanup(); }
});
