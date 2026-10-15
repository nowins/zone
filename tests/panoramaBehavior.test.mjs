import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { panoramaDepth, panoramaStep, panoramaWheel } from "../.tmp/visualizer-tests/utils/quickplayPanorama.js";

await build({ stdin: { contents: `export { useQuickplayPanorama } from './src/hooks/useQuickplayPanorama';
export { _setAnimationClockForTesting } from './src/motion/animate';`, resolveDir: process.cwd(), loader: "tsx" },
  outfile: ".tmp/panorama-tests/runtime.js", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { useQuickplayPanorama, _setAnimationClockForTesting } = await import("../.tmp/panorama-tests/runtime.js");

test("panorama depth and group stops remain bounded at either edge", () => {
  const groups = [{ id: "pins", left: 16, width: 240 }, { id: "continue", left: 300, width: 300 }, { id: "history", left: 650, width: 350 }];
  const depth = panoramaDepth(400, false);
  assert.ok(depth.title < depth.backdrop && depth.backdrop < 0);
  assert.ok(Math.abs(depth.title) < 400);
  assert.deepEqual(panoramaDepth(1000, true), { title: 0, backdrop: 0 });
  assert.deepEqual(panoramaDepth(-30, false), { title: -0, backdrop: -0 });
  assert.deepEqual(panoramaDepth(1e6, false), panoramaDepth(1e7, false));
  assert.equal(panoramaStep(0, 1, 600, groups), 284);
  assert.equal(panoramaStep(600, -1, 600, groups), 284);
  assert.equal(panoramaStep(600, 1, 600, groups), 600);
  assert.equal(panoramaStep(0, 1, 0, groups), 0);
});

test("vertical lists retain wheel ownership, while Shift and horizontal input pan", () => {
  const input = { deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: false, ctrlKey: false, viewportWidth: 920, verticalOverflow: true };
  assert.equal(panoramaWheel(input), null);
  assert.deepEqual(panoramaWheel({ ...input, shiftKey: true }), { delta: 96, smooth: true });
  assert.deepEqual(panoramaWheel({ ...input, deltaX: 80, deltaY: 4, deltaMode: 0 }), { delta: 80, smooth: false });
  assert.equal(panoramaWheel({ ...input, shiftKey: true, ctrlKey: true }), null);
});

test("panorama coordinates input, restoration, resize, reduced motion and cleanup in StrictMode", async () => {
  const dom = new JSDOM('<body><div id="root"></div><div id="portal"></div></body>');
  for (const key of ["window", "document", "Node", "Element", "HTMLElement"]) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const observers = new Set(), frames = [], mediaListeners = new Set(), timers = new Map();
  const layout = { width: 400, scrollWidth: 1100, entrance: 12 };
  let now = 0, hidden = false, current, timerId = 0;
  window.setTimeout = (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; };
  window.clearTimeout = id => timers.delete(id);
  const media = { matches: false, addEventListener: (_, fn) => mediaListeners.add(fn), removeEventListener: (_, fn) => mediaListeners.delete(fn) };
  window.matchMedia = () => media;
  Object.defineProperty(document, "hidden", { get: () => hidden });
  globalThis.ResizeObserver = class {
    constructor(fn) { this.fn = fn; observers.add(this); }
    observe() {}
    disconnect() { observers.delete(this); }
  };
  _setAnimationClockForTesting(() => now, fn => frames.push(fn));
  const rect = (left, width) => ({ left, right: left + width, top: 0, bottom: 500, width, height: 500 });
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.dataset.panoramaSection ? rect(Number(this.dataset.left) - (document.querySelector(".quickplay-viewport")?.scrollLeft ?? 0)
      + (this.dataset.panoramaSection === "continue" ? layout.entrance : 0), 260) : rect(0, layout.width);
  };
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", { configurable: true, get() { return Number(this.dataset.left ?? 0); } });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return this.dataset.panoramaSection ? 260 : layout.width; } });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => layout.width });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => layout.scrollWidth });
  HTMLElement.prototype.setPointerCapture = function (id) { this.captured = id; };
  HTMLElement.prototype.hasPointerCapture = function (id) { return this.captured === id; };
  HTMLElement.prototype.releasePointerCapture = function () { this.captured = null; };
  const sections = [{ id: "pins", label: "固定" }, { id: "continue", label: "继续播放" }, { id: "history", label: "播放历史" }];
  function Harness({ enabled = true }) {
    current = useQuickplayPanorama(enabled, sections.map(section => section.id));
    return React.createElement("section", null,
      React.createElement("div", { className: "quickplay-ghost", ref: current.titleRef }),
      React.createElement("div", { className: "quickplay-backdrop", ref: current.backdropRef }),
      enabled && React.createElement("div", { className: "quickplay-viewport", ref: current.viewportRef, tabIndex: 0, ...current.viewportProps },
        React.createElement("div", null, sections.map((section, index) => React.createElement("article", { key: section.id, "data-panorama-section": section.id, "data-left": 16 + index * 320 },
          React.createElement("button", null, section.label), React.createElement("div", { className: "quick-section-scroll" }))))),
      React.createElement("div", { ref: current.navigationRef }, [-1, 1].map(direction => React.createElement("button", {
        key: direction, "data-panorama-step": direction, onClick: event => current.step(direction, event.detail > 0),
      }, direction < 0 ? "上一组" : "下一组"))),
      enabled && React.createElement("input", { className: "quick-panorama-scrollbar", ref: current.scrollbarRef,
        type: "range", min: 0, step: "any", defaultValue: 0, disabled: !current.overflow, ...current.scrollbarProps }));
  }
  let root = createRoot(document.getElementById("root"));
  const render = async enabled => act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Harness, { enabled }))));
  const advance = async ms => act(async () => { const end = now + ms; while (now < end) {
    now += 16; frames.splice(0).forEach(fn => fn(now));
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  } });
  const wheel = async (element, params, legacyDelta) => {
    const event = new window.WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true, ...params });
    if (legacyDelta !== undefined) Object.defineProperty(event, "wheelDelta", { value: legacyDelta });
    await act(async () => element.dispatchEvent(event));
    return event.defaultPrevented;
  };
  const key = async (element, key) => act(async () => element.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
  try {
    await render(false); await render(true);
    let viewport = document.querySelector(".quickplay-viewport");
    let scrollbar = document.querySelector(".quick-panorama-scrollbar");
    assert.equal(scrollbar.classList.contains("is-scrolling"), false, "mount does not flash a scrollbar");
    const previous = document.querySelector('[data-panorama-step="-1"]'), next = document.querySelector('[data-panorama-step="1"]');
    assert.equal(previous.disabled, true); assert.equal(next.disabled, false);
    await act(async () => next.click());
    assert.equal(viewport.scrollLeft, 320, "keyboard activation uses the group layout and ignores its transient entrance offset");
    assert.equal(previous.disabled, false);
    await act(async () => previous.click());
    assert.equal(viewport.scrollLeft, 0); assert.equal(previous.disabled, true);
    await key(viewport, "Home");
    assert.equal(await wheel(viewport, {}), true);
    await advance(80);
    assert.ok(viewport.scrollLeft > 0 && viewport.scrollLeft < 120);
    assert.equal(scrollbar.classList.contains("is-scrolling"), true);
    assert.equal(scrollbar.valueAsNumber, viewport.scrollLeft);
    await wheel(viewport, {}); await advance(1200);
    assert.equal(Math.round(viewport.scrollLeft), 240, "successive wheel ticks accumulate without restarting velocity");
    await advance(800);
    assert.equal(scrollbar.classList.contains("is-scrolling"), false, "the bar sleeps once scrolling settles");
    assert.notEqual(document.querySelector(".quickplay-ghost").style.transform, "translate3d(0px, 0, 0)");
    assert.equal(await wheel(document.getElementById("portal"), {}), false);
    const nested = viewport.querySelector(".quick-section-scroll");
    Object.defineProperty(nested, "scrollHeight", { value: 900 });
    Object.defineProperty(nested, "clientHeight", { value: 200 });
    nested.scrollTop = 700;
    const beforeNestedWheel = viewport.scrollLeft;
    assert.equal(await wheel(nested, {}), true, "the vertical scroll handler contains a coarse wheel at the list edge");
    await advance(32);
    assert.equal(viewport.scrollLeft, beforeNestedWheel, "list edge must not jump to another section");
    assert.equal(await wheel(nested, { shiftKey: true }), true);
    await key(viewport, "Home"); await advance(1200);
    assert.equal(viewport.scrollLeft, 0, "keyboard input cancels old inertia");
    await wheel(viewport, { deltaX: 80, deltaY: 0 });
    assert.equal(viewport.scrollLeft, 80, "trackpad horizontal motion has no extra spring");
    assert.equal(await wheel(nested, { deltaX: 8, deltaY: 0 }, -120), true);
    assert.equal(viewport.scrollLeft, 88, "coarse legacy fields cannot enlarge or suppress a fine horizontal gesture over a list");
    await key(viewport.querySelector("button"), "End");
    assert.equal(viewport.scrollLeft, 88, "nested controls retain their shortcuts");
    assert.equal(await wheel(scrollbar, { deltaX: 8, deltaY: 0 }), true);
    assert.equal(viewport.scrollLeft, 96, "the visible scrollbar is not a dead zone for wheel input");
    await key(viewport, "End");
    assert.equal(viewport.scrollLeft, 700);
    const restoredTransform = document.querySelector(".quickplay-ghost").style.transform;
    await act(async () => root.unmount());
    assert.equal(observers.size, 0);
    assert.equal(timers.size, 0);
    root = createRoot(document.getElementById("root")); await render(true);
    viewport = document.querySelector(".quickplay-viewport");
    scrollbar = document.querySelector(".quick-panorama-scrollbar");
    assert.equal(viewport.scrollLeft, 700);
    assert.equal(scrollbar.valueAsNumber, 700);
    assert.equal(scrollbar.classList.contains("is-scrolling"), false, "restoring a page is not a new user scroll");
    assert.equal(document.querySelector(".quickplay-ghost").style.transform, restoredTransform, "restoration positions both layers before paint");
    await act(async () => { media.matches = true; mediaListeners.forEach(fn => fn()); });
    assert.equal(document.querySelector(".quickplay-ghost").style.transform, "translate3d(0px, 0, 0)");
    await key(viewport, "Home"); await wheel(viewport, {});
    assert.equal(viewport.scrollLeft, 120);
    await act(async () => { layout.width = 1000; observers.forEach(o => o.fn()); });
    assert.equal(viewport.scrollLeft, 100);
    assert.equal(scrollbar.max, "100", "resize updates the actual scroll range");
    await act(async () => {
      scrollbar.value = "42";
      scrollbar.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal(viewport.scrollLeft, 42, "scrubbing the scrollbar controls the viewport");
    const pointer = async type => act(async () => scrollbar.dispatchEvent(Object.assign(new window.Event(type, { bubbles: true }), { button: 0, pointerId: 9 })));
    await pointer("pointerdown"); await advance(1500);
    assert.equal(scrollbar.classList.contains("is-scrolling"), true, "the thumb remains available during a long drag");
    await pointer("pointerup"); await advance(800);
    assert.equal(scrollbar.classList.contains("is-scrolling"), false);
    await act(async () => { layout.width = 1200; observers.forEach(o => o.fn()); });
    assert.equal(scrollbar.disabled, true, "all content fits, so the scrollbar has no focus stop");
    assert.equal(document.querySelector('[data-panorama-step="-1"]').disabled, true);
    assert.equal(document.querySelector('[data-panorama-step="1"]').disabled, true);
    await act(async () => { layout.width = 1000; observers.forEach(o => o.fn()); });
    await act(async () => { media.matches = false; mediaListeners.forEach(fn => fn()); });
    await key(viewport, "Home"); await wheel(viewport, {});
    await act(async () => { hidden = true; document.dispatchEvent(new window.Event("visibilitychange")); });
    const stopped = viewport.scrollLeft; await advance(1200);
    assert.equal(viewport.scrollLeft, stopped);
    assert.equal(scrollbar.classList.contains("is-scrolling"), false);
    assert.equal(timers.size, 0);
  } finally { await act(async () => root.unmount()); assert.equal(observers.size, 0); assert.equal(timers.size, 0); assert.equal(mediaListeners.size, 0); dom.window.close(); }
});
