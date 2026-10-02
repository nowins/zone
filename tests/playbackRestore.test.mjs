import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";

await build({ entryPoints: ["src/hooks/usePlaybackControls.ts"], outfile: ".tmp/playback-restore/hook.js", bundle: true,
  packages: "external", format: "esm", platform: "browser", logLevel: "silent", define: { "import.meta.env.DEV": "false" }, plugins: [{ name: "native", setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "core", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export class Channel {} export const convertFileSrc = path => path; export const invoke = async () => ({trackId:'one',activity:{addedAt:1,playCount:0,completedCount:0,skipCount:0}});", loader: "js" }));
  } }] });
const { usePlaybackControls } = await import("../.tmp/playback-restore/hook.js");
const tracks = ["one", "two"].map(id => ({ id, title: id, artist: "歌手", album: "专辑", path: `${id}.mp3`, duration_seconds: 120 }));

test("restored music stays paused, restores position and explicit actions still play", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zone.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  const noop = () => {};
  let plays = 0, state, hydrate;
  const audio = { currentTime: 0, duration: 120, paused: true, src: "", load: noop, removeAttribute: noop,
    pause() { this.paused = true; }, play() { plays++; this.paused = false; return Promise.resolve(); } };
  const audioRef = { current: audio }, sessionRef = { current: null };
  const engine = { cancelBeatAnalysis: noop, resumeAudioGraph: noop, preAnalyzeBeatGrid: noop, publishIdleBeatFrame: noop, publishPodcastVisualizerReset: noop,
    visualizerUnavailableRef: {}, realtimeBeatRef: {}, offlineBeatGridRef: {}, beatFrameRef: {} };
  function Fixture() {
    const [activeTrackId, setActiveTrackId] = useState(null), [queue, setQueue] = useState([]), [playHistory, setPlayHistory] = useState([]), [library, setLibrary] = useState([]);
    state = usePlaybackControls({ audioRef, playbackSessionRef: sessionRef, audioEngineRef: { current: engine }, showActionNotice: noop,
      tracks: library, restored: true, setTrackActivity: noop, activeTrackId, setActiveTrackId, queue, setQueue, playHistory, setPlayHistory,
      podcast: { activePodcastEpisode: null, podcastPlaybackRate: 1, podcastSessionHydrated: true, setPodcastPlaybackStatus: noop,
        cancelPendingQueueConsume: noop, cancelPodcastSessionRestore: noop, clearActivePodcast: noop, flushPodcastProgress: noop,
        persistPodcastProgress: noop, resumePodcastProgressWrites: noop, consumePendingPodcastQueueEpisode: noop, handleEpisodeEnded: noop } });
    hydrate = () => { state.restoreMusicPosition("one", 42); setLibrary(tracks); setQueue(["one", "two"]); setActiveTrackId("one"); };
    return null;
  }
  const root = createRoot(document.getElementById("root"));
  try {
    await act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Fixture))));
    await act(() => hydrate());
    assert.equal(plays, 0); assert.equal(state.progress, 42); assert.equal(state.getMusicPosition(), 42);
    await act(() => state.handleLoadedMetadata(audio)); assert.equal(audio.currentTime, 42); assert.equal(state.isPlaying, false);
    await act(() => state.togglePlay()); assert.equal(plays, 1); assert.equal(state.isPlaying, true);
    await act(() => state.togglePlay()); assert.equal(audio.paused, true);
    await act(() => state.playTrack(tracks[1])); assert.equal(plays, 2); assert.equal(state.activeTrack.id, "two"); assert.equal(state.getMusicPosition(), 0);
    await act(() => state.handleTimeUpdate(25, 120)); assert.equal(state.getMusicPosition(), 25);
    await act(() => state.playTrack(tracks[1])); assert.equal(plays, 3); assert.equal(state.getMusicPosition(), 0);
  } finally {
    await act(() => root.unmount()); dom.window.close();
    for (const key of ["window", "document", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) delete globalThis[key];
  }
});
