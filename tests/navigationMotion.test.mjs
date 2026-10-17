import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";

await build({ stdin: { contents: `export { useNavigation } from './src/hooks/useNavigation';`, resolveDir: process.cwd(), loader: "tsx" },
  outfile: ".tmp/navigation-motion-runtime.js", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { useNavigation } = await import("../.tmp/navigation-motion-runtime.js");

test("navigation mounts immediately, accepts batched reversals and keeps keyboard search responsive", async () => {
  const dom = new JSDOM('<body><div id="root"></div></body>', { pretendToBeVisual: true });
  for (const key of ["window", "document", "Node", "Element", "HTMLElement", "MutationObserver"]) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const listeners = new Set(), frames = [];
  const media = { matches: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  window.matchMedia = () => media;
  window.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
  let navigation;
  let collectionMounted = true;
  const targets = { current: { activeTrack: { id: "song" }, activePodcastEpisode: null } };
  function Fixture() {
    navigation = useNavigation({ contextMenu: null, infoTarget: null, addToPlaylistTarget: null,
      playlistDialog: null, smartPlaylistDialog: null, nowPlayingTargetsRef: targets });
    return React.createElement("section", { ref: navigation.workspaceRef, "data-page": navigation.page },
      navigation.page === "collection" && collectionMounted && React.createElement("input", { ref: navigation.searchInputRef, "aria-label": "搜索收藏" }));
  }
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Fixture))));
    assert.equal(navigation.quickplayEntrance, true);
    await act(async () => navigation.requestNavigation("collection"));
    assert.equal(document.querySelector("section").dataset.page, "collection", "there is no exit timeout before the target mounts");
    await act(async () => navigation.requestNavigation("quickplay"));
    assert.equal(navigation.page, "quickplay", "immediate reversal is not mistaken for a same-page request");
    assert.equal(navigation.quickplayEntrance, false, "returning never replays tile arrival");
    assert.equal(navigation.navigationAnimated, true, "rapid input keeps the spatial hand-off enabled");
    await act(async () => { navigation.requestNavigation("collection"); navigation.requestNavigation("quickplay"); });
    assert.equal(navigation.page, "quickplay", "the latest intent wins even in one React batch");
    await act(async () => { navigation.requestNavigation("podcasts"); navigation.requestNavigation("settings"); });
    assert.equal(navigation.page, "settings");
    await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true })));
    assert.equal(navigation.page, "collection");
    assert.equal(navigation.navigationAnimated, true, "keyboard search keeps motion while focusing immediately");
    await act(async () => frames.splice(0).forEach(fn => fn(0)));
    assert.equal(document.activeElement, navigation.searchInputRef.current, "Ctrl+F focuses in the first frame");
    await act(async () => { navigation.collection.openIndex("songs"); navigation.collection.openIndex("albums"); });
    await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, cancelable: true })));
    assert.equal(navigation.view, "songs");
    assert.equal(navigation.collection.history.animate, true, "keyboard history retains the same directional pivot");
    await act(async () => { media.matches = true; listeners.forEach(fn => fn()); navigation.navigatePage("settings"); });
    assert.equal(navigation.navigationAnimated, false);
    await act(async () => navigation.openNowPlaying());
    assert.equal(navigation.page, "nowPlaying");
    assert.equal(navigation.previousPageRef.current, "settings");
    collectionMounted = false;
    await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true })));
    await act(async () => frames.splice(0).forEach(fn => fn(0)));
    assert.equal(navigation.searchInputRef.current, null, "a lazy collection can miss the navigation frame");
    collectionMounted = true;
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Fixture))));
    assert.equal(document.activeElement, navigation.searchInputRef.current, "late content consumes the pending search focus");
  } finally { await act(async () => root.unmount()); assert.equal(listeners.size, 0); dom.window.close(); }
});

test("now playing preserves its trigger, names the return destination and respects lazy-screen focus", async () => {
  const dom = new JSDOM('<body><div id="root"></div></body>', { pretendToBeVisual: true });
  for (const key of ["window", "document", "Node", "Element", "HTMLElement", "MutationObserver"]) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  let navigation, stageMounted = true, browsingMounted = true, keyboard = true;
  const nativeMatches = window.HTMLElement.prototype.matches;
  window.HTMLElement.prototype.matches = function(selector) {
    return selector === ":focus-visible" ? keyboard : nativeMatches.call(this, selector);
  };
  const targets = { current: { activeTrack: { id: "song" }, activePodcastEpisode: null } };
  function Fixture() {
    navigation = useNavigation({ contextMenu: null, infoTarget: null, addToPlaylistTarget: null,
      playlistDialog: null, smartPlaylistDialog: null, nowPlayingTargetsRef: targets });
    return React.createElement("div", { className: "shell" },
      React.createElement("button", { id: "window-control" }, "窗口"),
      React.createElement("section", { ref: navigation.workspaceRef, "data-page": navigation.page },
        navigation.page === "nowPlaying"
          ? stageMounted && React.createElement("button", { className: targets.current.activePodcastEpisode ? "podcast-now-back" : "now-back", onClick: navigation.returnFromNowPlaying, title: navigation.nowPlayingBackLabel }, "返回")
          : browsingMounted && React.createElement("div", null,
            ...["cover", "title", "queue"].map(key => React.createElement("button", { key, "data-now-playing-trigger": key, onClick: navigation.openNowPlaying }, key)),
            React.createElement("button", { "data-collection-focus": "quick-continue", onClick: navigation.openNowPlaying }, "继续播放"))));
  }
  const root = createRoot(document.getElementById("root"));
  const render = () => act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Fixture))));
  const trigger = key => document.querySelector(`[data-now-playing-trigger="${key}"]`);
  try {
    await render();
    for (const [page, label] of [["quickplay", "返回首页"], ["collection", "返回收藏"], ["podcasts", "返回播客"], ["settings", "返回设置"]]) {
      await act(async () => navigation.navigatePage(page));
      for (const key of ["cover", "title", "queue"]) {
        trigger(key).focus();
        await act(async () => trigger(key).click());
        assert.ok(document.activeElement === document.querySelector(".now-back"), "keyboard entry lands on the back control");
        assert.equal(document.activeElement.title, label);
        await act(async () => document.activeElement.click());
        assert.ok(document.activeElement === trigger(key), "return resumes at the exact action that opened the stage");
      }
    }
    await act(async () => navigation.navigatePage("quickplay"));
    document.querySelector('[data-collection-focus="quick-continue"]').focus();
    await act(async () => navigation.openNowPlaying());
    await act(async () => navigation.returnFromNowPlaying());
    assert.equal(document.activeElement.dataset.collectionFocus, "quick-continue", "quickplay artwork keeps its own focus identity");

    targets.current = { activeTrack: null, activePodcastEpisode: { episodeId: "episode" } };
    trigger("cover").focus();
    await act(async () => navigation.openNowPlaying());
    assert.ok(document.activeElement === document.querySelector(".podcast-now-back"), "podcast playback uses the same keyboard handoff");
    await act(async () => navigation.returnFromNowPlaying());
    assert.ok(document.activeElement === trigger("cover"));
    targets.current = { activeTrack: { id: "song" }, activePodcastEpisode: null };

    keyboard = false;
    const mouseTrigger = trigger("cover");
    mouseTrigger.focus();
    await act(async () => mouseTrigger.click());
    assert.ok(document.activeElement === document.body, "pointer entry does not add keyboard emphasis to the stage");
    await act(async () => navigation.returnFromNowPlaying());
    assert.ok(document.activeElement === trigger("cover"));
    keyboard = true;

    stageMounted = false; trigger("title").focus();
    await act(async () => navigation.openNowPlaying());
    assert.ok(document.activeElement === document.body);
    stageMounted = true; await render();
    assert.ok(document.activeElement === document.querySelector(".now-back"), "lazy stage mounting consumes the pending focus");
    browsingMounted = false;
    await act(async () => navigation.returnFromNowPlaying());
    browsingMounted = true; await render();
    assert.ok(document.activeElement === trigger("title"), "lazy browsing mounting restores the original action");
    await act(async () => navigation.openNowPlaying());
    browsingMounted = false;
    await act(async () => navigation.returnFromNowPlaying());
    document.getElementById("window-control").focus();
    browsingMounted = true; await render();
    assert.equal(document.activeElement.id, "window-control", "late mounting does not steal a newer user selection");

    stageMounted = false; trigger("queue").focus();
    await act(async () => navigation.openNowPlaying());
    await act(async () => navigation.navigatePage("settings"));
    stageMounted = true; await render();
    assert.equal(navigation.page, "settings");
    assert.ok(document.activeElement === document.body, "unrelated navigation cancels pending stage focus");
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
