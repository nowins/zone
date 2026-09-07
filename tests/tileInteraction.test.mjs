import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

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
  return { root, timers, observers, frames,
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
    await env.advance(first + 800);
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
    source.getBoundingClientRect = () => rect(0, 100);
    target.getBoundingClientRect = () => rect(100, 100);
    document.elementFromPoint = () => target;
    await start();
    assert.ok(document.querySelector(".quick-pin-drag-ghost"));
    assert.equal(moves.length, 0, "preview must not write persistent order");
    await pointer(grid, "pointerup", 180);
    assert.deepEqual(moves, [["one", "two", true]]);
    assert.equal(document.querySelector(".quick-pin-drag-ghost"), null);

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
