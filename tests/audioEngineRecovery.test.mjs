import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const runtimePath = `.tmp/audio-recovery-${process.pid}/runtime.mjs`;
await build({ entryPoints: ["src/hooks/useAudioEngine.ts"], outfile: runtimePath,
  bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { useAudioEngine } = await import(new URL(`../${runtimePath}`, import.meta.url));

async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zone.test", pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  window.__TAURI_INTERNALS__ = { invoke: async () => {} };
  let engine, context, sources = 0, contexts = 0, resume;
  let source = { kind: "music" };
  const node = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
  window.AudioContext = class extends window.EventTarget {
    state = "running";
    calls = 0;
    constructor() { super();context = this;contexts++; }
    createAnalyser() { return node(); }
    createMediaElementSource() { sources++;return node(); }
    createGain() { return node(); }
    resume() { this.calls++;return resume ? resume() : Promise.resolve().then(() => { this.state = "running"; }); }
  };
  const audio = { paused: false, currentTime: 42, volume: .5 };
  let props = { audioRef: { current: audio }, volume: .5, progress: 42, isPlaying: true,
    activePlayback: source, activePlaybackSourceKey: "music:one", activeTrackId: "one", visualizerVisible: false };
  const root = createRoot(document.getElementById("root"));
  let mounted = true;
  const unmount = async () => { if (mounted) { await act(async () => root.unmount());mounted = false; } };
  function Harness() { engine = useAudioEngine(props);return null; }
  const render = () => act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Harness))));
  await render();await engine.resumeAudioGraph();
  return { audio, get engine() { return engine; }, get context() { return context; }, get sources() { return sources; }, get contexts() { return contexts; },
    set resume(value) { resume = value; },
    render: async changes => { props = { ...props, ...changes };await render(); },
    returned: async type => act(async () => (type === "visibilitychange" ? document : window).dispatchEvent(new window.Event(type))),
    unmount, close: async () => { await unmount();dom.window.close(); },
  };
}

test("concurrent graph resume requests share one attempt and retain the single media source", async () => {
  const h = await fixture();const pending = [];
  try {
    h.context.state = "suspended";
    h.resume = () => new Promise(resolve => pending.push(resolve));
    const first = h.engine.resumeAudioGraph(), second = h.engine.resumeAudioGraph();
    await Promise.resolve();
    assert.equal(h.context.calls, 1);
    pending.forEach(resolve => resolve());await Promise.all([first, second]);
    assert.equal(h.sources, 1);assert.equal(h.contexts, 1);
  } finally { pending.forEach(resolve => resolve());await h.close(); }
});

test("music returning from a suspended graph resumes without restarting media, including compact and reduced-motion surfaces", async () => {
  const h = await fixture();
  try {
    for (const event of ["focus", "pageshow", "visibilitychange"]) {
      h.context.state = "suspended";const before = h.context.calls;
      await h.returned(event);assert.equal(h.context.calls, before + 1, event);
      assert.equal(h.context.state, "running");assert.equal(h.audio.currentTime, 42);
    }
    assert.equal(h.sources, 1);assert.equal(h.contexts, 1);
  } finally { await h.close(); }
});

test("a rejected resume stays handled and a later explicit request can retry", async () => {
  const h = await fixture();
  try {
    h.context.state = "suspended";h.resume = () => Promise.reject(new Error("interrupted output"));
    await assert.doesNotReject(h.engine.resumeAudioGraph());
    assert.equal(h.context.calls, 1);
    h.resume = undefined;await h.engine.resumeAudioGraph();
    assert.equal(h.context.calls, 2);assert.equal(h.context.state, "running");
  } finally { await h.close(); }
});

test("paused media, podcast sleep ownership and hidden pages cannot trigger music graph recovery", async () => {
  const h = await fixture();
  try {
    h.context.state = "suspended";h.audio.paused = true;
    await h.returned("focus");assert.equal(h.context.calls, 0);
    h.audio.paused = false;await h.render({ isPlaying: false });
    await h.returned("pageshow");assert.equal(h.context.calls, 0);
    await h.render({ isPlaying: true, activePlayback: { kind: "podcast" }, activePlaybackSourceKey: "podcast:one" });
    await h.returned("focus");assert.equal(h.context.calls, 0, "podcast recovery must expire sleep first");
    await h.render({ activePlayback: { kind: "music" }, activePlaybackSourceKey: "music:one" });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await h.returned("visibilitychange");assert.equal(h.context.calls, 0);
    await h.unmount();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await h.returned("focus");
    assert.equal(h.context.calls, 0);
  } finally { await h.close(); }
});
