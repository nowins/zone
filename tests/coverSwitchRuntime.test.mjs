import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

await build({ stdin: { contents: `export { Cover } from './src/components/Cover';
export { PodcastNowBackdrop } from './src/components/PodcastNowBackdrop';`, resolveDir: process.cwd(), loader: "tsx" },
  outfile: ".tmp/cover-tests/runtime.js", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { Cover, PodcastNowBackdrop } = await import("../.tmp/cover-tests/runtime.js");

function environment() {
  const dom = new JSDOM('<body><div id="root"></div></body>');
  const saved = [];
  const install = (key, value) => {
    saved.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { configurable: true, value });
  };
  for (const key of ["window", "document", "Node", "Element", "HTMLElement", "getComputedStyle"]) install(key, dom.window[key]);
  install("IS_REACT_ACT_ENVIRONMENT", true);
  let now = 0, id = 0;
  const timers = new Map(), frames = new Map(), images = [], resizes = new Set(), draws = new WeakMap();
  const listeners = new Set();
  const media = { matches: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  window.matchMedia = () => media;
  window.__TAURI_INTERNALS__ = { convertFileSrc: path => path };
  install("performance", { now: () => now });
  window.setTimeout = (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; };
  window.clearTimeout = key => timers.delete(key);
  window.requestAnimationFrame = fn => { frames.set(++id, fn); return id; };
  window.cancelAnimationFrame = key => frames.delete(key);
  install("requestAnimationFrame", window.requestAnimationFrame);
  install("cancelAnimationFrame", window.cancelAnimationFrame);
  install("ResizeObserver", class {
    constructor(fn) { this.fn = fn; resizes.add(this); }
    observe() {}
    disconnect() { resizes.delete(this); }
  });
  install("Image", class extends EventTarget {
    constructor() { super(); this.complete = false; this.naturalWidth = this.naturalHeight = 0; images.push(this); }
    decode() { return Promise.resolve(); }
    load(ok = true) {
      this.complete = true;
      this.naturalWidth = this.naturalHeight = ok ? 100 : 0;
      if (ok) this.onload?.();
      this.dispatchEvent(new Event(ok ? "load" : "error"));
    }
  });
  dom.window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1180, height: 760 });
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    if (!draws.has(this)) draws.set(this, []);
    return {
      setTransform() {}, clearRect: () => draws.set(this, []), save() {}, restore() {}, translate() {}, rotate() {}, beginPath() {}, rect() {}, clip() {},
      strokeRect() {}, fillRect() {}, createLinearGradient: () => ({ addColorStop() {} }),
      drawImage: image => draws.get(this).push(image), getImageData: () => ({ data: new Uint8ClampedArray(48 * 48 * 4).fill(128) }),
    };
  };
  const root = createRoot(document.getElementById("root"));
  return { images, draws,
    render: element => act(async () => root.render(React.createElement(React.StrictMode, null, element))),
    load: (path, ok = true) => act(async () => images.filter(image => image.src === path && !image.complete).forEach(image => image.load(ok))),
    advance: ms => act(async () => {
      const end = now + ms;
      do {
        now = Math.min(now + 16, end);
        for (const [key, timer] of timers) if (timer.at <= now) { timers.delete(key); timer.fn(); }
        const pending = [...frames]; frames.clear(); pending.forEach(([, fn]) => fn(now));
      } while (now < end);
    }),
    resize: () => act(async () => resizes.forEach(observer => observer.fn())),
    reduce: () => act(async () => { media.matches = true; listeners.forEach(fn => fn()); }),
    cleanup: async () => {
      await act(async () => { images.filter(image => !image.complete).forEach(image => image.load(false)); root.unmount(); });
      assert.equal(resizes.size, 0); assert.equal(frames.size, 0);
      dom.window.close();
      saved.reverse().forEach(([key, descriptor]) => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
    },
  };
}

test("Cover assigns each native image request a distinct node and ignores errors from detached requests", async () => {
  const env = environment();
  const render = src => env.render(React.createElement(Cover, { src, label: "封面" }));
  try {
    await render("A"); const old = document.querySelector("img");
    await render("B"); const current = document.querySelector("img");
    assert.notEqual(current, old);
    await act(async () => old.dispatchEvent(new window.Event("error")));
    assert.equal(document.querySelector("img"), current);
    await act(async () => current.dispatchEvent(new window.Event("error")));
    assert.equal(document.querySelector("img"), null);
    assert.equal(document.querySelector(".cover").dataset.coverReady, "false");
    await act(async () => old.dispatchEvent(new window.Event("error")));
    assert.equal(document.querySelector("img"), null, "late error cannot resurrect a failed replacement");
    await render("C"); assert.equal(document.querySelector("img").getAttribute("src"), "C");
  } finally { await env.cleanup(); }
});

test("podcast ambience follows newly mounted artwork and rejects a superseded palette load", async () => {
  const env = environment();
  const render = artworkSrc => env.render(React.createElement(PodcastNowBackdrop, { artworkSrc }));
  try {
    await render(null); await env.advance(16);
    await render("podcast-A"); await env.advance(16);
    assert.ok(document.querySelector("img").style.transform.includes("scale("), "late-mounted artwork receives the current drift");
    await render("podcast-B"); await env.load("podcast-A");
    const backdrop = document.querySelector(".podcast-now-backdrop");
    assert.equal(backdrop.style.getPropertyValue("--podcast-now-wash-a"), "");
    await env.load("podcast-B");
    assert.ok(backdrop.style.getPropertyValue("--podcast-now-wash-a"));
    await env.reduce();
    assert.equal(document.querySelector("img").style.transform, "");
  } finally { await env.cleanup(); }
});
