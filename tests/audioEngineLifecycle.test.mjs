import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

// Bundle the hook and bus together so assertions read the sampler's actual slot.
await build({ stdin: { contents: `
  export { useAudioEngine } from "./src/hooks/useAudioEngine";
  export { getVisualizerFrame } from "./src/utils/visualizerBus";
`, resolveDir: process.cwd(), loader: "ts" }, outfile: ".tmp/audio-engine-tests/runtime.mjs",
  bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { useAudioEngine, getVisualizerFrame } = await import("../.tmp/audio-engine-tests/runtime.mjs");

test("shared music sampler keeps one loop across browsing and sleeps on mute, hide, compact and reduced motion", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById("root"));
  const frames = new Map();
  const listeners = new Set();
  const commands = [];
  let nextId = 0;
  let hidden = false;
  let signal = true;
  let sourceCount = 0;
  let samples = 0;
  const media = { matches: false, addEventListener: (_, callback) => listeners.add(callback),
    removeEventListener: (_, callback) => listeners.delete(callback) };
  window.matchMedia = () => media;
  window.__TAURI_INTERNALS__ = { invoke: async command => { commands.push(command); } };
  Object.defineProperty(document, "visibilityState", { get: () => hidden ? "hidden" : "visible" });
  Object.defineProperty(document, "hidden", { get: () => hidden });
  globalThis.requestAnimationFrame = window.requestAnimationFrame = callback => { frames.set(++nextId, callback); return nextId; };
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame = id => frames.delete(id);
  window.AudioContext = class {
    state = "running";
    sampleRate = 48000;
    createAnalyser() {
      return { fftSize: 4096, frequencyBinCount: 2048, connect() {},
        getByteFrequencyData(data) { samples++; data.fill(signal ? 130 : 0); },
        getByteTimeDomainData(data) { for (let i = 0; i < data.length; i++) data[i] = signal ? 128 + Math.round(50 * Math.sin(i * 0.2)) : 128; },
      };
    }
    createMediaElementSource() { sourceCount++; return { connect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
  };
  const audioRef = { current: { currentTime: 1, volume: 0.5 } };
  const initial = { audioRef, volume: 0.5, progress: 1, isPlaying: true, activePlayback: { kind: "music" },
    activePlaybackSourceKey: "music:a", activeTrackId: "a", visualizerVisible: true };
  function Harness(props) { useAudioEngine(props); return null; }
  const render = async (changes = {}) => act(() => root.render(React.createElement(React.StrictMode, null,
    React.createElement(Harness, { ...initial, ...changes }))));
  const step = () => { audioRef.current.currentTime += 0.016; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
  const assertSilent = () => {
    assert.equal(getVisualizerFrame().energy, 0);
    assert.ok(getVisualizerFrame().samples.every(value => value === 0));
    assert.ok(getVisualizerFrame().transients.every(value => value === 0));
  };
  try {
    await render();
    step();
    assert.equal(sourceCount, 1, "StrictMode does not reconnect the primary audio element");
    assert.equal(frames.size, 1);
    assert.ok(getVisualizerFrame().energy > 0, "the live signal reaches the bus outside now playing");
    const sampleCount = samples;
    const scheduledFrame = [...frames.keys()][0];
    await render({ page: "collection", progress: 2, volume: 0.6 });
    assert.equal(samples, sampleCount, "browsing, progress and audible volume updates preserve the current sampler");
    assert.equal([...frames.keys()][0], scheduledFrame);
    await render({ volume: 0 });
    assert.equal(frames.size, 0);
    assertSilent();
    await render();
    assert.equal(frames.size, 1, "unmute resumes");
    document.documentElement.dataset.zoneWindowVisible = "false";
    document.dispatchEvent(new window.Event("zone-window-visibility"));
    assert.equal(frames.size, 0, "native hiding stops sampling even with a visible document");
    assertSilent();
    delete document.documentElement.dataset.zoneWindowVisible;
    document.dispatchEvent(new window.Event("zone-window-visibility"));
    assert.equal(frames.size, 1, "native showing restarts the sampler");
    hidden = true;
    document.dispatchEvent(new window.Event("visibilitychange"));
    assert.equal(frames.size, 0);
    assertSilent();
    hidden = false;
    document.dispatchEvent(new window.Event("visibilitychange"));
    assert.equal(frames.size, 1);
    await render({ visualizerVisible: false });
    assert.equal(frames.size, 0, "compact mode stops sampling");
    await render();
    await act(() => { media.matches = true; listeners.forEach(callback => callback()); });
    assert.equal(frames.size, 0, "reduced motion uses the Canvas static substitute");
    assertSilent();
    await act(() => { media.matches = false; listeners.forEach(callback => callback()); });
    assert.equal(frames.size, 1);
    await render({ isPlaying: false });
    assert.equal(frames.size, 0);
    assertSilent();
    await render({ activePlayback: { kind: "podcast" }, activePlaybackSourceKey: "podcast:a" });
    assert.equal(frames.size, 0, "podcasts never run the music sampler");
    assertSilent();
    signal = false;
    await render({ activePlaybackSourceKey: "music:b", activeTrackId: "b" });
    for (let i = 0; i < 10; i++) step();
    assertSilent();
    assert.equal(sourceCount, 1, "source changes reuse the same audio graph");
    assert.ok(!commands.includes("music_decode_beat_window"), "opening a visual surface does not start offline analysis");
  } finally {
    await act(() => root.unmount());
    assert.equal(frames.size, 0);
    assert.equal(listeners.size, 0);
    dom.window.close();
  }
});
