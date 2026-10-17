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
      export const listen = (event, handler) => window.zoneListen(event, handler);
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
  const calls = [];
  const eventListeners = new Map(), eventCalls = []; let listenerId = 0;
  window.zoneListen = async (event, handler) => {
    const id = ++listenerId; eventCalls.push(event);eventListeners.set(id, { event, handler });
    return () => eventListeners.delete(id);
  };
  window.zoneInvoke = async (command, args) => {
    commands.push(command);
    calls.push({ command, args });
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
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
  window.requestIdleCallback = fn => { const id = ++clockId; idles.set(id, fn); return id; };
  window.cancelIdleCallback = id => idles.delete(id);
  const root = createRoot(document.getElementById("root"));
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  return { root, commands, calls, frames, idles, eventCalls, eventListeners,
    async emit(event) { await act(async () => {
      for (const listener of [...eventListeners.values()]) if (listener.event === event) listener.handler({ event, payload: null });
    }); },
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

test("tray subscriptions stay mounted across clock updates and read the latest transport", async t => {
  const tracks = [track, { ...track, id: "second", title: "第二首", path: "C:/fixture/second.wav" },
    { ...track, id: "third", title: "第三首", path: "C:/fixture/third.wav" }];
  const env = environment(t, { music_get_library_snapshot: () => ({ ...snapshot(tracks),
    playback: { ...snapshot(tracks).playback, positionSeconds: 0 } }) });
  window.HTMLMediaElement.prototype.play = async function () { Object.defineProperty(this, "paused", { configurable: true, value: false }); };
  await env.mount();
  const audio = document.querySelector("audio");
  Object.defineProperty(audio, "duration", { configurable: true, value: 120 });
  Object.defineProperty(audio, "readyState", { configurable: true, value: 4 });
  await act(async () => audio.dispatchEvent(new window.Event("loadedmetadata")));
  const trayCalls = () => env.eventCalls.filter(event => event.startsWith("zone://tray-"));
  const before = trayCalls().length;
  for (let time = 1; time <= 10; time++) {
    await act(async () => { audio.currentTime = time;audio.dispatchEvent(new window.Event("timeupdate")); });
  }
  assert.equal(trayCalls().length, before, "progress must not churn native subscriptions");
  await env.emit("zone://tray-next");
  assert.match(document.querySelector(".zune-progress-heading").textContent, /第二首/);
  await env.emit("zone://tray-next");
  assert.match(document.querySelector(".zune-progress-heading").textContent, /第三首/, "the same listener must use the latest queue position");
  assert.equal(trayCalls().length, before);
  assert.equal([...env.eventListeners.values()].filter(value => value.event.startsWith("zone://tray-")).length, 3);
  await act(async () => env.root.unmount());
  assert.equal([...env.eventListeners.values()].filter(value => value.event.startsWith("zone://tray-")).length, 0);
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

const legacyKey = "zone-player-state-v1";
function legacyState() { return JSON.stringify({ librarySchemaVersion: 6, tracks: [track],
  folders: [{ path: "C:/fixture", name: "fixture" }], activeTrackId: track.id, queue: [track.id],
  shuffle: false, playlists: [], homePins: [], trackActivity: {} }); }
async function settleSaves() { await act(async () => new Promise(resolve => setTimeout(resolve, 450))); }
async function confirmRecovery() {
  await act(async () => document.querySelector(".library-recovery-notice button").click());
  assert.match(document.querySelector('[role="dialog"]').textContent, /临时修改不会写入数据库/);
  await act(async () => document.querySelector('[role="dialog"] button[type="submit"]').click());
}
const saveCommands = ["music_save_playlists", "music_save_home_pins", "music_save_track_activity", "music_save_playback_state"];

test("normal startup enables every automatic persistence channel", async t => {
  const env = environment(t);
  await env.mount(); await settleSaves();
  for (const command of saveCommands) assert.ok(env.commands.includes(command), command);
  assert.equal(document.querySelector(".library-recovery-notice"), null);
});

test("legacy fallback keeps a persistent warning, pauses music writes and preserves edits on failed retry", async t => {
  const env = environment(t, { music_get_library_snapshot: () => Promise.reject(Error("offline")) });
  const raw = legacyState(); localStorage.setItem(legacyKey, raw);
  await env.mount();
  assert.ok(document.querySelector(".quickplay"));
  await act(async () => document.querySelector('[title="随机播放"]').click());
  await act(async () => new Promise(resolve => setTimeout(resolve, 2500)));
  assert.match(document.querySelector(".library-recovery-notice").textContent, /当前修改未保存/);
  assert.equal(localStorage.getItem(legacyKey), raw);
  assert.equal(env.commands.some(command => saveCommands.includes(command) || ["music_scan_library", "music_session_start", "music_session_end", "music_analyze_features"].includes(command)), false);
  // Cancelling the dialog is a pure UI action.
  const attempts = env.commands.filter(command => command === "music_get_library_snapshot").length;
  await act(async () => document.querySelector(".library-recovery-notice button").click());
  await act(async () => document.querySelector('[role="dialog"] button[type="button"]').click());
  assert.equal(env.commands.filter(command => command === "music_get_library_snapshot").length, attempts);
  await confirmRecovery(); await settleSaves();
  assert.ok(document.querySelector(".quickplay"));
  assert.equal(document.querySelector('[title="随机播放"]').getAttribute("aria-pressed"), "true");
  assert.ok(document.querySelector(".library-recovery-notice"));
  assert.equal(localStorage.getItem(legacyKey), raw);
  assert.equal(env.commands.some(command => saveCommands.includes(command)), false);
});

test("successful degraded recovery reloads database state before restarting persistence", async t => {
  let fail = true;
  const recovery = deferred();
  const dbTrack = { ...track, id: "db-track", title: "数据库中的歌曲" };
  const env = environment(t, { music_get_library_snapshot: () => fail ? Promise.reject(Error("offline")) : recovery.promise });
  const raw = legacyState(); localStorage.setItem(legacyKey, raw);
  await env.mount();
  await act(async () => document.querySelector('[title="随机播放"]').click());
  fail = false; await confirmRecovery();
  assert.equal(document.querySelector(".library-recovery-notice button").disabled, true);
  await settleSaves(); assert.equal(env.commands.some(command => saveCommands.includes(command)), false);
  await act(async () => recovery.resolve(snapshot([dbTrack])));
  await settleSaves();
  assert.equal(document.querySelector(".library-recovery-notice"), null);
  assert.ok(document.querySelector(".quickplay").textContent.includes(dbTrack.title));
  assert.equal(localStorage.getItem(legacyKey), raw, "existing database must not consume or overwrite the legacy source");
  assert.equal(env.commands.includes("music_import_legacy_player_state"), false);
  for (const command of saveCommands) assert.ok(env.commands.includes(command), command);
  const playback = env.calls.filter(call => call.command === "music_save_playback_state").at(-1).args.playback;
  assert.equal(playback.activeTrackId, dbTrack.id);
  assert.equal(playback.shuffle, false, "volatile edits must never overwrite recovered database state");
  await act(async () => document.querySelector('[title="随机播放"]').click()); await settleSaves();
  assert.equal(env.calls.filter(call => call.command === "music_save_playback_state").at(-1).args.playback.shuffle, true);
});

test("degraded recovery migrates only the original legacy source and retains it when migration fails", async t => {
  let offline = true, importFails = true;
  const raw = legacyState();
  const env = environment(t, {
    music_get_library_snapshot: () => offline ? Promise.reject(Error("offline")) : { ...snapshot([]), hasLibrary: false },
    music_import_legacy_player_state: ({ legacy }) => {
      assert.deepEqual(legacy, JSON.parse(raw));
      if (importFails) throw Error("import failed");
      return snapshot();
    },
  });
  localStorage.setItem(legacyKey, raw); await env.mount();
  await act(async () => document.querySelector('[title="随机播放"]').click());
  offline = false; await confirmRecovery(); await settleSaves();
  assert.ok(document.querySelector(".library-recovery-notice"));
  assert.equal(localStorage.getItem(legacyKey), raw);
  assert.equal(env.commands.some(command => saveCommands.includes(command)), false);
  importFails = false; await confirmRecovery(); await settleSaves();
  assert.equal(document.querySelector(".library-recovery-notice"), null);
  assert.equal(localStorage.getItem(legacyKey), null);
  assert.equal(localStorage.getItem(legacyKey + "-backup"), raw);
  for (const command of saveCommands) assert.ok(env.commands.includes(command), command);
});
