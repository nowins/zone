import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { build } from "esbuild";
import { scheduleBackgroundTask } from "../.tmp/visualizer-tests/utils/backgroundTask.js";

await build({ entryPoints: ["src/App.tsx", "src/components/StartupView.tsx"], outdir: ".tmp/startup-tests",
  bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent",
  define: { "import.meta.env.DEV": "false", __ZONE_BUILD_ID__: '"test"', __ZONE_RELEASE_LINKS__: "{}" },
  plugins: [{ name: "native-host", setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\// }, args => ({ path: args.path, namespace: "native-host" }));
    builder.onLoad({ filter: /.*/, namespace: "native-host" }, () => ({ contents: `
      export const invoke = (command, args) => window.zoneInvoke(command, args);
      export const isTauri = () => false;
      export const convertFileSrc = path => "asset://" + path;
      export class Channel {}
      export const listen = async () => () => {};
      export const getCurrentWindow = () => ({
        minimize: async () => window.zoneWindowActions.push("minimize"),
        toggleMaximize: async () => window.zoneWindowActions.push("maximize"),
        hide: async () => window.zoneWindowActions.push("hide"),
        destroy: async () => window.zoneWindowActions.push("destroy"),
        onCloseRequested: async () => () => {},
      });`, loader: "js" }));
  } }],
});
const { default: App } = await import("../.tmp/startup-tests/App.js");
const { StartupShell } = await import("../.tmp/startup-tests/components/StartupView.js");
const h = React.createElement;
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const track = { id: "startup-track", title: "启动恢复的歌曲", artist: "测试艺术家", album: "测试专辑",
  path: "C:/fixture/song.wav", file_name: "song.wav", extension: "wav", cover_path: null, duration_seconds: 120 };
function snapshot(tracks = [track]) { return { tracks, folders: [], homePins: [], playlists: [], trackActivity: {},
  playback: { activeTrackId: tracks[0]?.id ?? null, queue: tracks.map(item => item.id), positionSeconds: 42, playHistory: [], volume: 0.6, shuffle: false, repeat: "off" }, hasLibrary: true }; }

function environment(t, overrides = {}) {
  const dom = new JSDOM('<body><div id="root"></div></body>', { url: "http://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "HTMLElement", "HTMLAudioElement", "Element", "Node", "MutationObserver", "Event", "KeyboardEvent", "Image", "localStorage"]) globalThis[key] = dom.window[key];
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.HTMLMediaElement.prototype.load = () => {};
  window.HTMLMediaElement.prototype.pause = () => {};
  window.zoneWindowActions = [];
  const commands = [];
  window.zoneInvoke = async (command, args) => {
    commands.push(command);
    if (overrides[command]) return overrides[command](args);
    if (command === "podcast_load_active_episode" || command === "music_get_radio_session") return null;
    if (command === "podcast_get_preferences") return {};
    if (command === "music_list_track_features") return {};
    if (command === "music_get_library_snapshot") return snapshot();
    return [];
  };
  const frames = new Map(), idles = new Map(); let clockId = 0;
  window.requestAnimationFrame = fn => { const id = ++clockId; frames.set(id, fn); return id; };
  window.cancelAnimationFrame = id => frames.delete(id);
  window.requestIdleCallback = fn => { const id = ++clockId; idles.set(id, fn); return id; };
  window.cancelIdleCallback = id => idles.delete(id);
  const root = createRoot(document.getElementById("root"));
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  return { root, commands, frames, idles,
    async mount(view = h(App)) { await act(async () => root.render(h(React.StrictMode, null, view))); },
    async frame() { const batch = [...frames.values()]; frames.clear(); await act(async () => batch.forEach(fn => fn(0))); },
    async idle() { const batch = [...idles.values()]; idles.clear(); await act(async () => batch.forEach(fn => fn({ timeRemaining: () => 50 }))); },
  };
}

test("startup keeps the empty library and transport hidden until music and podcast recovery complete", async t => {
  const music = deferred(), podcast = deferred();
  const env = environment(t, { music_get_library_snapshot: () => music.promise, podcast_load_active_episode: () => podcast.promise });
  await env.mount();
  const audio = document.querySelector("audio");
  assert.ok(document.querySelector('.startup-view[role="status"]'));
  assert.equal(document.querySelector(".quickplay"), null);
  assert.ok([...document.querySelectorAll(".primary-pivot button")].every(button => button.disabled));
  await act(async () => music.resolve(snapshot()));
  assert.equal(document.querySelector(".quickplay"), null, "music alone must not reveal a stale music session");
  assert.equal(env.commands.includes("music_analyze_features"), false);
  await act(async () => podcast.resolve(null));
  assert.equal(document.querySelector(".startup-view"), null);
  assert.ok(document.querySelector(".quickplay").textContent.includes(track.title));
  assert.equal(document.querySelector("audio"), audio, "the startup hand-off must preserve the unique audio element");
  assert.equal(document.querySelector("main").getAttribute("aria-busy"), "false");
  await env.frame(); await env.frame(); await env.idle();
  assert.equal(env.commands.filter(command => command === "music_analyze_features").length, 1);
});

test("a recovered empty library reveals the real empty state only after recovery", async t => {
  const music = deferred(); const env = environment(t, { music_get_library_snapshot: () => music.promise });
  await env.mount(); assert.equal(document.querySelector(".quickplay"), null);
  await act(async () => music.resolve(snapshot([])));
  assert.ok(document.querySelector(".quickplay"));
  assert.equal(document.querySelector(".startup-view"), null);
});

test("failed startup offers retry, preserves legacy data and never enables database writes", async t => {
  let fail = true;
  const env = environment(t, { music_get_library_snapshot: () => fail ? Promise.reject(Error("offline")) : Promise.resolve(snapshot()) });
  localStorage.setItem("zone-player-state-v1", "{broken");
  await env.mount();
  assert.ok(document.querySelector('.startup-view[role="alert"]'));
  assert.equal(document.querySelector(".quickplay"), null);
  assert.equal(localStorage.getItem("zone-player-state-v1"), "{broken");
  await act(async () => new Promise(resolve => setTimeout(resolve, 450)));
  assert.equal(env.commands.some(command => command.startsWith("music_save_")), false);
  fail = false;
  await act(async () => document.querySelector(".startup-view button").click());
  assert.ok(document.querySelector(".quickplay"));
  assert.equal(document.querySelector(".startup-view"), null);
});

test("the early shell exposes working native window controls and respects close preferences", async t => {
  const env = environment(t);
  localStorage.setItem("zone-playback-behavior-v1", JSON.stringify({ closeToTray: false }));
  await env.mount(h(StartupShell));
  await act(async () => {
    document.querySelector('[title="最小化"]').click();
    document.querySelector('[title="关闭"]').click();
  });
  assert.deepEqual(window.zoneWindowActions, ["minimize", "destroy"]);
});

test("optional startup work is cancellable at either frame or the idle boundary", async t => {
  const env = environment(t); let ran = 0;
  const first = scheduleBackgroundTask(() => ran++); first();
  await env.frame(); await env.frame(); await env.idle(); assert.equal(ran, 0);
  const second = scheduleBackgroundTask(() => ran++); await env.frame(); second();
  await env.frame(); await env.idle(); assert.equal(ran, 0);
  const third = scheduleBackgroundTask(() => ran++); await env.frame(); await env.frame(); third();
  await env.idle(); assert.equal(ran, 0);
  delete window.requestIdleCallback;
  scheduleBackgroundTask(() => ran++); await env.frame(); await env.frame();
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(ran, 1);
});

test("native and document backgrounds are dark before application code loads", () => {
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  assert.equal(config.app.windows[0].backgroundColor, "#0b070c");
  assert.match(readFileSync("index.html", "utf8"), /<html[^>]+background: #0b070c/);
  assert.match(readFileSync("src/styles/motion.css", "utf8"), /@media \(prefers-reduced-motion: reduce\)[\s\S]+\.startup-loading/);
});
