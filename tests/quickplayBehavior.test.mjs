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
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
