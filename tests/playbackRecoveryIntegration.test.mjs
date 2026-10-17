import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";

const runtimePath = `.tmp/playback-recovery-${process.pid}/runtime.mjs`;
await build({ stdin: { contents: `
  export { usePlaybackControls } from "./src/hooks/usePlaybackControls";
  export { useAudioEngine } from "./src/hooks/useAudioEngine";
`, resolveDir: process.cwd(), loader: "ts" }, outfile: runtimePath, bundle: true,
  packages: "external", format: "esm", platform: "browser", logLevel: "silent",
  define: { "import.meta.env.DEV": "false" }, plugins: [{ name: "native", setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "core", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export class Channel {}
      export const convertFileSrc = path => path;
      export const invoke = async command => {
        if (command === "music_decode_beat_window") throw new Error("No native decoder in fixture");
        return { trackId: "one", activity: { addedAt: 1 } };
      };
    `, loader: "js" }));
  } }] });
const { usePlaybackControls, useAudioEngine } = await import(new URL(`../${runtimePath}`, import.meta.url));
const tracks = [{ id: "one", title: "歌曲", artist: "歌手", album: "专辑", path: "one.mp3" }];

async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zone.test", pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } });
  let context, state, chooseEpisode, sources = 0, plays = 0, loads = 0, expired = false;
  window.AudioContext = class {
    state = "running";calls = 0;
    constructor() { context = this; }
    createAnalyser() { return node(); }
    createMediaElementSource() { sources++;return node(); }
    createGain() { return node(); }
    resume() { this.calls++;this.state = "running";return Promise.resolve(); }
  };
  const audio = new window.EventTarget();
  Object.assign(audio, { paused: true, currentTime: 42, duration: 120, error: null,
    load() { loads++;this.paused = true; }, removeAttribute() {},
    pause() { this.paused = true;state?.handleAudioPause(); },
    play() { plays++;this.paused = false;return Promise.resolve(); } });
  const devices = new window.EventTarget(), pending = [], notices = [];
  let deferDevices = false;
  devices.enumerateDevices = () => deferDevices ? new Promise(resolve => pending.push(resolve))
    : Promise.resolve([{ kind: "audiooutput", deviceId: "headphones", groupId: "headphones" }]);
  Object.defineProperty(window.navigator, "mediaDevices", { value: devices });
  const audioRef = { current: audio }, engineRef = { current: null }, sessionRef = { current: null };
  const noop = () => {};
  function Harness() {
    const [episode, setEpisode] = useState(null), [activeTrackId, setActiveTrackId] = useState("one");
    const [queue, setQueue] = useState(["one"]), [playHistory, setPlayHistory] = useState([]);
    chooseEpisode = setEpisode;
    state = usePlaybackControls({ audioRef, audioEngineRef: engineRef, playbackSessionRef: sessionRef,
      tracks, activeTrackId, setActiveTrackId, queue, setQueue, playHistory, setPlayHistory,
      restored: true, persistenceReady: false, setTrackActivity: noop, showActionNotice: value => notices.push(value),
      podcast: { activePodcastEpisode: episode, podcastPlaybackRate: 1.5, podcastSessionHydrated: true,
        setPodcastPlaybackStatus: noop, clearActivePodcast: () => setEpisode(null),
        cancelPendingQueueConsume: noop, cancelPendingPodcastAutofill: noop, cancelPodcastSessionRestore: noop,
        flushPodcastProgress: noop, persistPodcastProgress: noop, resumePodcastProgressWrites: noop,
        consumePendingPodcastQueueEpisode: noop, handleEpisodeEnded: noop,
        expireSleepTimer: () => { if (!expired) return false;state.clearPlaybackIntent();audio.pause();return true; } } });
    engineRef.current = useAudioEngine({ audioRef, volume: state.volume, progress: state.progress,
      isPlaying: state.isPlaying, activePlayback: state.activePlayback, activePlaybackSourceKey: state.activePlaybackSourceKey,
      activeTrackId, visualizerVisible: false });
    return null;
  }
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Harness))));
  const event = async (target, type) => act(async () => target.dispatchEvent(new window.Event(type)));
  return { audio, devices, pending, notices, get state() { return state; }, get context() { return context; },
    get plays() { return plays; }, get loads() { return loads; }, get sources() { return sources; },
    set expired(value) { expired = value; }, set deferDevices(value) { deferDevices = value; },
    event, focus: () => event(window, "focus"),
    podcast: id => act(async () => { state.armPodcastPlay({ episodeId: id });chooseEpisode({ episodeId: id, savedProgressSeconds: 0 }); }),
    close: async () => { await act(async () => root.unmount());dom.window.close(); } };
}

test("actual transport generations prevent focus from reloading a manually continued podcast", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await fixture();
  try {
    await h.podcast("first");await h.event(h.audio, "waiting");
    await act(async () => h.state.pausePlayback());await act(async () => h.state.togglePlay());
    const loads = h.loads, plays = h.plays;
    await h.focus();await act(async () => t.mock.timers.tick(500));
    assert.equal(h.loads, loads);assert.equal(h.plays, plays);assert.equal(h.state.isPlaying, true);
    await h.event(h.audio, "waiting");await h.focus();await act(async () => t.mock.timers.tick(500));
    assert.equal(h.loads, loads + 1, "a fresh stall in this generation still reconnects");
  } finally { await h.close();t.mock.timers.reset(); }
});

test("episode replacement and music takeover discard pending device work and retain sleep ownership", async () => {
  const h = await fixture();
  try {
    await h.podcast("first");h.deferDevices = true;await h.event(h.devices, "devicechange");
    await h.podcast("second");
    await act(async () => h.pending[0]([{ kind: "audiooutput", deviceId: "speakers" }]));
    assert.equal(h.state.isPlaying, true);assert.equal(h.notices.length, 0);
    h.context.state = "suspended";h.expired = true;const calls = h.context.calls;
    await h.focus();assert.equal(h.audio.paused, true);assert.equal(h.context.calls, calls);
    h.expired = false;await act(async () => h.state.togglePlay());
    const oldReads = h.pending.length;await h.event(h.devices, "devicechange");
    await act(async () => h.state.playTrack(tracks[0]));
    await act(async () => h.pending.slice(oldReads).forEach(resolve => resolve([])));
    assert.equal(h.state.activePlayback.kind, "music");assert.equal(h.audio.playbackRate, 1);
    assert.equal(h.state.isPlaying, true);assert.equal(h.notices.length, 0);
    h.context.state = "suspended";const musicCalls = h.context.calls;
    await h.focus();assert.equal(h.context.calls, musicCalls + 1);assert.equal(h.sources, 1);
    const reads = h.pending.length;await h.event(h.devices, "devicechange");
    assert.equal(h.pending.length, reads, "podcast device listener is removed after music takeover");
  } finally { await h.close(); }
});
