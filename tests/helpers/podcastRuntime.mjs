import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const runtimePath = `.tmp/podcast-runtime-${process.pid}/runtime.mjs`;
await build({
  stdin: { contents: `
    export { usePodcastPlayback } from "./src/hooks/usePodcastPlayback";
    export { usePlaybackControls } from "./src/hooks/usePlaybackControls";
    export { usePodcastViewModel } from "./src/views/podcast/usePodcastViewModel";
    export { EpisodeBrowser } from "./src/views/podcast/components/EpisodeBrowser";
    export { setPodcastSessionSnapshot, setDiscoveryCache, discoveryCache } from "./src/views/podcast/cache";
  `, resolveDir: process.cwd(), loader: "ts" },
  outfile: runtimePath, bundle: true, packages: "external", format: "esm",
  platform: "browser", define: { "import.meta.env.DEV": "false" }, logLevel: "silent",
});
export const runtime = await import(new URL(`../../${runtimePath}`, import.meta.url));
export const step = async (callback = () => {}) => act(async () => { await callback(); });
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
export const podcastFeed = { id: "feed", feedUrl: "https://example.com/feed.xml", title: "节目",
  subscribed: true, lastFetchedAt: Date.now(), unplayedCount: 2 };
export const podcastEpisode = (id, extra = {}) => ({ id, feedId: "feed", title: id,
  enclosureUrl: `https://example.com/${id}.mp3`, downloadState: "none", downloadedBytes: 0,
  saved: false, completed: false, progressSeconds: 0, durationSeconds: 1000,
  feedTitle: "节目", ...extra });
export const podcastPlayback = (episode) => ({ ...episode, episodeId: episode.id,
  podcastTitle: "节目", savedProgressSeconds: episode.progressSeconds });
export const podcastDetail = (episode) => ({ episode, feed: podcastFeed, saved: episode.saved,
  hasChapters: false, transcriptCount: 0 });

export async function mountPodcastHook(hook, props, invoke, settings = {}, renderView = () => null) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.requestAnimationFrame = () => 1;
  window.cancelAnimationFrame = () => {};
  window.__TAURI_INTERNALS__ = { invoke };
  window.__TAURI_INTERNALS__.convertFileSrc = (file, protocol = "asset") => `http://${protocol}.localhost/${file}`;
  localStorage.setItem("zone-podcast-playback-v1", JSON.stringify(settings));
  runtime.setPodcastSessionSnapshot(null);
  let value;
  function Harness() { value = hook(props); return renderView(value); }
  const root = createRoot(document.getElementById("root"));
  await step(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Harness))));
  return { get api() { return value; }, dom,
    render: async (next) => {
      props = next;
      await step(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Harness))));
    },
    close: async () => { await step(() => root.unmount()); dom.window.close(); },
  };
}

export async function mountPodcastPlayback(invoke, settings = {}, session = {}) {
  const audioRef = { current: { currentTime: 0, duration: 1000, paused: true, ended: false,
    pause() { this.paused = true; } } };
  const armed = [];
  const notices = [];
  let intent = false;
  const playbackControlsRef = { current: {
    armPodcastPlay: (options) => { intent = true; armed.push(options); },
    clearPlaybackIntent: () => { intent = false; }, setPlaybackIntent: (value) => { intent = value; },
    hasEpisodeStartedOnDevice: () => false, peekPendingResumePosition: () => null,
    clearPendingPodcastStart() {}, seek: (value) => { audioRef.current.currentTime = value; },
    togglePlay() { audioRef.current.paused = !audioRef.current.paused; },
  } };
  const mounted = await mountPodcastHook(runtime.usePodcastPlayback, {
    audioRef, playbackControlsRef, playbackSessionRef: { current: null }, requestNavigation() {},
    showActionNotice: (message) => notices.push(message),
  }, async (command, args) => {
    if (command === "podcast_load_active_episode") return session.load ? session.load() : null;
    if (command === "podcast_save_active_episode") return session.save?.(args.episodeId);
    return invoke(command, args);
  }, settings);
  return { ...mounted, get api() { return mounted.api; }, audioRef, playbackControlsRef,
    armed, notices, get intent() { return intent; } };
}
