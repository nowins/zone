import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

await build({ entryPoints: ["src/views/QuickplayView.tsx"], outfile: ".tmp/quickplay-tests/view.js",
  bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent",
  define: { "import.meta.env.DEV": "false" } });
const { QuickplayView } = await import("../.tmp/quickplay-tests/view.js");

test("continue displays the real music clock and keeps cover and caption activation consistent", async () => {
  const dom = new JSDOM('<body><div id="root"></div></body>');
  for (const name of ["window", "document", "Node", "Element", "HTMLElement"]) globalThis[name] = dom.window[name];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const root = createRoot(document.getElementById("root")), calls = [];
  const track = { id: "music", title: "当前歌曲", artist: "艺术家", album: "专辑", duration_seconds: 180, path: "/a.mp3" };
  const props = { tracks: [track], albums: [], artists: [], playlists: [], activeTrack: track, historyIds: [], activity: {}, favoriteTrackIds: new Set(), homePins: [],
    onResumePlayback: () => calls.push("resume"), onOpenNowPlaying: () => calls.push("open"), onPlay: () => calls.push("restart") };
  const render = async patch => act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(QuickplayView, { ...props, ...patch }))));
  try {
    await render({ progress: 72, duration: 240 });
    const clock = () => document.querySelector('[role="progressbar"]');
    assert.equal(clock().getAttribute("aria-valuenow"), "72");
    assert.equal(clock().getAttribute("aria-valuetext"), "1:12 / 4:00");
    assert.equal(document.querySelector('.quick-resume-track > span').style.width, "30%");
    for (const selector of [".quick-cover-button", ".quick-caption"]) await act(async () => document.querySelector(selector).click());
    assert.deepEqual(calls, ["resume", "open", "resume", "open"]);
    await render({ progress: 999, duration: 240 }); assert.equal(clock().getAttribute("aria-valuenow"), "240");
    await render({ progress: NaN, duration: 0 }); assert.equal(clock().getAttribute("aria-valuetext"), "0:00 / 3:00");
    await render({ podcastActive: true, progress: 55, duration: 300 }); assert.equal(clock(), null);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});

test("podcast-only quickplay survives StrictMode and opens its show after hydration", async () => {
  const dom = new JSDOM('<body><div id="root"></div></body>');
  for (const name of ["window", "document", "Node", "Element", "HTMLElement"]) globalThis[name] = dom.window[name];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const root = createRoot(document.getElementById("root"));
  let opened = null;
  const props = { tracks: [], albums: [], artists: [], playlists: [], activeTrack: null, historyIds: [],
    activity: {}, favoriteTrackIds: new Set(), homePins: [{ id: "pin", kind: "podcastFeed", targetId: "feed", createdAt: 1 }],
    onOpenPodcastFeed: id => { opened = id; }, onPlay() { throw Error("must not play music"); } };
  const render = async podcastFeeds => act(async () => root.render(React.createElement(React.StrictMode, null,
    React.createElement(QuickplayView, { ...props, podcastFeeds }))));
  try {
    await render([]);
    assert.equal(document.querySelector(".quickplay-empty"), null);
    await render([{ id: "feed", title: "测试节目", author: "作者", artworkUrl: null, unplayedCount: 3 }]);
    const button = [...document.querySelectorAll("button")].find(element => element.title === "打开节目 测试节目");
    assert.ok(button, "podcast pin appears without local music");
    await act(async () => button.click());
    assert.equal(opened, "feed");
    assert.equal(document.querySelector(".quickplay-empty-content"), null);
    assert.equal(document.querySelector('.quick-pin-badge'),null,'historical unplayed episodes are not new update alerts');
    for (const size of ['small','medium','wide']) {
      await act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(QuickplayView,{...props,homePins:[{...props.homePins[0],size,live:false}],podcastFeeds:[{id:'feed',title:'测试节目',unplayedCount:30,newEpisodeCount:2}]}))));
      assert.equal(document.querySelector('.quick-pin-badge')?.textContent,'2');
      const badge = document.querySelector('.quick-pin-badge');
      assert.ok(badge?.parentElement.classList.contains('quick-pin-surface'),'badge follows the stable edit surface');
      assert.equal(badge?.closest('.tile-face'),null,'badge remains outside animated tile faces');
      assert.ok(document.querySelector('button[title="打开节目 测试节目，2 集更新"]'));
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("dense history rows retain their order, accessible names, playback and context actions", async () => {
  const dom = new JSDOM('<body><div id="root"></div></body>');
  for (const name of ["window", "document", "Node", "Element", "HTMLElement"]) globalThis[name] = dom.window[name];
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const tracks = Array.from({ length: 15 }, (_, i) => ({ id: String(i), title: `歌曲 ${i}`, artist: `歌手 ${i}`,
    album: "专辑", cover_path: null, path: `/${i}.mp3`, file_name: `${i}.mp3` }));
  let played, context;
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(QuickplayView, {
      tracks, albums: [], artists: [], playlists: [], activeTrack: tracks[0], historyIds: tracks.map(track => track.id),
      activity: {}, favoriteTrackIds: new Set(), homePins: [],
      onPlay: (track, source) => { played = { track, source }; }, onContextMenu: (_, payload) => { context = payload; },
    }))));
    const rows = [...document.querySelectorAll(".quick-history-row")];
    assert.equal(rows.length, 12);
    assert.deepEqual(rows.map(row => row.getAttribute("aria-label")), tracks.slice(1, 13).map(track => `播放 ${track.title} · ${track.artist}`));
    await act(async () => rows[11].click());
    assert.equal(played.track, tracks[12]);
    assert.equal(played.source, tracks);
    await act(async () => rows[11].dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true })));
    assert.deepEqual(context.tracks, [tracks[12]]);
    assert.equal(context.playbackTracks, tracks);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
