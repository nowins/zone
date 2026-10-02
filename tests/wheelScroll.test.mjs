import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";

await build({ stdin: { contents: `export { attachWheelScroll, isCoarseVerticalWheel } from './src/motion/wheelScroll';
export { useWheelScroll } from './src/hooks/useWheelScroll';
export { _setAnimationClockForTesting } from './src/motion/animate';`, resolveDir: process.cwd(), loader: "tsx" },
  outfile: ".tmp/wheel-scroll-runtime.js", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { attachWheelScroll, isCoarseVerticalWheel, useWheelScroll, _setAnimationClockForTesting } = await import("../.tmp/wheel-scroll-runtime.js");

test("coarse wheel signals are distinguished from fine and diagonal gestures", () => {
  const signal = { deltaX: 0, deltaY: 120, deltaMode: 0 };
  assert.equal(isCoarseVerticalWheel(signal), true);
  assert.equal(isCoarseVerticalWheel({ ...signal, deltaY: 5 }), false);
  assert.equal(isCoarseVerticalWheel({ ...signal, deltaY: 80.5 }), false);
  assert.equal(isCoarseVerticalWheel({ ...signal, deltaX: 1 }), false);
  assert.equal(isCoarseVerticalWheel({ ...signal, deltaY: 3, deltaMode: 1 }), true);
  assert.equal(isCoarseVerticalWheel({ ...signal, deltaY: -1, deltaMode: 2 }), true);
});

function environment(t) {
  const dom = new JSDOM('<body><div id="mount"></div><section id="root"><div data-scroll><button>歌曲</button></div></section><div id="portal"></div></body>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  const root = document.getElementById("root"), area = root.firstElementChild;
  Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 900 });
  Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 200 });
  const frames = []; let now = 0;
  _setAnimationClockForTesting(() => now, fn => frames.push(fn));
  const advance = ms => { for (const end = now + ms; now < end;) { now += 16; frames.splice(0).forEach(fn => fn(now)); } };
  const wheel = (params = {}, target = area.firstElementChild) => {
    const event = new window.WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true, ...params });
    target.dispatchEvent(event); return event.defaultPrevented;
  };
  return { window, document, root, area, frames, advance, wheel };
}

test("wheel bursts continue from the current position, reverse and clamp within the list", t => {
  const { root, area, advance, wheel, frames } = environment(t);
  const stop = attachWheelScroll(root, "[data-scroll]"); t.after(stop);
  assert.equal(wheel(), true);
  assert.equal(area.scrollTop, 0, "coarse wheel does not jump a whole tick at once");
  advance(48); const first = area.scrollTop; assert.ok(first > 0 && first < 120);
  wheel(); assert.equal(area.scrollTop, first, "retargeting never resets the position");
  advance(1200); assert.equal(area.scrollTop, 240);
  wheel({ deltaY: -120 }); advance(1200); assert.equal(area.scrollTop, 120);
  wheel({ deltaY: 10000 }); advance(1200); assert.equal(area.scrollTop, 700);
  assert.equal(wheel(), true); advance(32);
  assert.equal(frames.length, 0, "a contained edge does not start idle frames");
  wheel({ deltaY: -1, deltaMode: 2 }); advance(1200); assert.equal(area.scrollTop, 500);
  wheel({ deltaY: -3, deltaMode: 1 }); advance(1200); assert.equal(area.scrollTop, 404);
});

test("fine gestures, native positioning, keyboard, pointer, hiding and cleanup take control", t => {
  const { window, document, root, area, advance, wheel } = environment(t);
  const stop = attachWheelScroll(root, "[data-scroll]");
  for (const params of [{ deltaY: 4 }, { deltaY: 80.5 }, { deltaX: 8 }, { shiftKey: true }, { ctrlKey: true }]) {
    wheel(); advance(32); const before = area.scrollTop;
    assert.equal(wheel(params), false); advance(1000); assert.equal(area.scrollTop, before);
  }
  for (const type of ["pointerdown", "keydown", "scroll", "resize", "visibilitychange", "blur"]) {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    wheel({ deltaY: -120 }); advance(32);
    if (type === "scroll") area.scrollTop = 300;
    if (type === "visibilitychange") Object.defineProperty(document, "hidden", { configurable: true, value: true });
    const before = area.scrollTop;
    const target = ["resize", "blur"].includes(type) ? window : type === "visibilitychange" ? document : area;
    target.dispatchEvent(new window.Event(type, { bubbles: true }));
    advance(1000); assert.equal(area.scrollTop, before, type);
  }
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  assert.equal(wheel({}, document.getElementById("portal")), false);
  wheel(); advance(32); stop(); const before = area.scrollTop;
  advance(1000); assert.equal(area.scrollTop, before);
  assert.equal(wheel(), false, "unmount removes the wheel listener");
});

test("the real hook cleans old owners on revision and disables smoothing under reduced motion", async t => {
  const env = environment(t), { window, document } = env;
  for (const key of ["window", "document", "Node", "Element", "HTMLElement"]) globalThis[key] = key === "window" ? window : window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const listeners = new Set();
  const media = { matches: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  window.matchMedia = () => media;
  function Fixture({ revision }) {
    const root = useRef(null); useWheelScroll(root, "[data-scroll]", revision);
    return React.createElement("section", { ref: root }, React.createElement("div", { key: revision, "data-scroll": "" }));
  }
  const root = createRoot(document.getElementById("mount"));
  const render = revision => act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Fixture, { revision }))));
  try {
    await render(1);
    const old = document.querySelector("#mount [data-scroll]"); env.wheel({}, old); env.advance(32); const before = old.scrollTop;
    await render(2); env.advance(1000); assert.equal(old.scrollTop, before);
    assert.ok(before > 0, "the old owner was moving before the revision");
    const area = document.querySelector("#mount [data-scroll]");
    env.wheel({}, area); env.advance(32); const moving = area.scrollTop;
    assert.ok(moving > 0);
    await act(async () => { media.matches = true; listeners.forEach(fn => fn()); });
    env.advance(1000); assert.equal(area.scrollTop, moving);
    assert.equal(env.wheel({}, area), false, "reduced motion leaves native scrolling in control");
    await act(async () => { media.matches = false; listeners.forEach(fn => fn()); });
    env.advance(1000); assert.equal(area.scrollTop, moving, "disabling reduced motion never replays a tick");
  } finally { await act(async () => root.unmount()); assert.equal(listeners.size, 0); }
});
