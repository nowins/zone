import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act, useRef, useState } from "react";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { collectionPivotDirection, playCollectionPivot } from "../.tmp/visualizer-tests/motion/collectionPivot.js";
import { initialCollectionHistory, pushCollectionLocation, travelCollectionHistory, emptyCollectionSurface } from "../.tmp/visualizer-tests/utils/collectionNavigation.js";
import { applyMotionTokens, BROWSE_MOTION, COLLECTION_PIVOT_MOTION, MOTION_STAGGER } from "../.tmp/visualizer-tests/motion/tokens.js";

test("categories, details and history have matching directions; keyboard category activation stays immediate", () => {
  let history = initialCollectionHistory();
  const open = (view, animate = true) => { history = pushCollectionLocation(history,
    { ...history.entries[history.cursor], view, surface: emptyCollectionSurface() }, emptyCollectionSurface(), animate); };
  open("songs"); assert.equal(collectionPivotDirection(history), 1);
  open("albums"); assert.equal(collectionPivotDirection(history), -1);
  history = travelCollectionHistory(history, -1, emptyCollectionSurface());
  assert.equal(collectionPivotDirection(history), 1, "returning to the category on the right reverses the prior pivot");
  history = travelCollectionHistory(history, 1, emptyCollectionSurface());
  assert.equal(collectionPivotDirection(history), -1);
  open("playlists", false); assert.equal(collectionPivotDirection(history), 0);
  const same = history; open("playlists"); assert.equal(history, same);
  history = pushCollectionLocation(history, { ...history.entries[history.cursor], entity: { kind: "track", id: "a" } }, emptyCollectionSurface());
  assert.equal(collectionPivotDirection(history), 1, "details use the same browsing entrance");
  history = travelCollectionHistory(history, -1, emptyCollectionSurface());
  assert.equal(collectionPivotDirection(history), -1, "leaving a detail animates back toward its source");
});

function environment(t) {
  const dom = new JSDOM('<body><div id="mount"></div></body>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  const animations = [];
  const rect = (top, height, left = 0, width = 500) => ({ top, bottom: top + height, left, right: left + width, width, height });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.dataset.row !== undefined) return rect(100 + Number(this.dataset.row) * 40, 40);
    return rect(100, 500);
  };
  window.HTMLElement.prototype.animate = function (frames, options) {
    const animation = { node: this, frames, options, playState: "running", onfinish: null, cancelled: false,
      cancel() { this.cancelled = true; this.playState = "idle"; },
      finish() { this.playState = "finished"; this.onfinish?.(); } };
    animations.push(animation); return animation;
  };
  const root = document.createElement("div");
  root.innerHTML = '<div class="collection-track-head"></div><div class="collection-track-scroll" data-collection-scroll="songs">' + Array.from({ length: 80 }, (_, i) =>
    `<div class="collection-track-row" data-row="${Math.floor(i / 2)}">歌曲 ${i}</div>`).join("") + '</div>';
  document.body.append(root);
  return { window, document, root, animations, rect };
}

test("content regions move once without row scaling or library-sized layout work", t => {
  const { root, animations, rect } = environment(t);
  let rowReads = 0;
  root.querySelectorAll('.collection-track-row').forEach(node => { node.getBoundingClientRect = () => { rowReads++; return rect(100, 40); }; });
  const stop = playCollectionPivot(root, -1);
  assert.equal(animations.length, 2, "only heading and list move, irrespective of row count");
  assert.equal(rowReads, 0, "no per-track rectangle scan");
  assert.equal(animations[0].frames[0].transform, "translate3d(-22px, 0, 0)");
  assert.equal(animations[1].frames[0].transform, "translate3d(-8px, 0, 0)");
  assert.deepEqual(animations.map(a => a.options.delay), [0, MOTION_STAGGER.step]);
  assert.ok(animations.every(a => a.options.duration === COLLECTION_PIVOT_MOTION.duration));
  assert.ok(animations.every(a => a.node !== root && !a.frames[0].transform.includes("scale")));
  stop(); assert.ok(animations.every(a => a.cancelled));
  animations.length = 0;
  root.innerHTML = Array.from({ length: 40 }, (_, i) => `<section class="collection-entity-section" data-row="${i}"><div class="collection-track-scroll"></div></section>`).join("");
  playCollectionPivot(root, 1);
  assert.equal(animations.length, COLLECTION_PIVOT_MOTION.maxGroups);
  assert.ok(animations.every(a => a.node.className === "collection-entity-section"), "nested lists inherit their section's movement");
  assert.equal(Math.max(...animations.map(a => a.options.delay)), MOTION_STAGGER.step * 2);
  animations.forEach(a => a.finish());
  assert.ok(animations.every(a => a.cancelled), "finished animations release their effects");
  animations.length = 0;
  root.getBoundingClientRect = () => rect(180, 80);
  playCollectionPivot(root, 1);
  assert.deepEqual(animations.map(a => a.node.dataset.row), ["2", "3"], "groups outside the viewport do not animate");
});

test("interaction, resize, hiding and cleanup settle an unfinished entrance without swallowing input", t => {
  const { root, animations, window, document } = environment(t);
  const shell = document.createElement("section"); shell.className = "collection-connected";
  const toolbar = document.createElement("button"); toolbar.textContent = "歌曲";
  root.replaceWith(shell); shell.append(toolbar, root);
  for (const event of ["pointerdown", "keydown", "wheel", "scroll", "resize", "visibilitychange"]) {
    animations.length = 0;
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const stop = playCollectionPivot(root, 1);
    const target = event === "resize" ? window : event === "visibilitychange" ? document : root.lastElementChild;
    const input = new window.Event(event, { bubbles: true, cancelable: true });
    if (event === "scroll") target.scrollTop += 1;
    if (event === "visibilitychange") Object.defineProperty(document, "hidden", { configurable: true, value: true });
    const original = [...animations];
    original.forEach(a => { a.node.style.transform = "matrix(1, 0, 0, 1, 6, 0)"; a.node.style.opacity = "0.6"; });
    target.dispatchEvent(input);
    assert.equal(input.defaultPrevented, false);
    assert.ok(original.every(a => a.cancelled), event);
    if (["wheel", "pointerdown", "scroll"].includes(event)) {
      const settling = animations.slice(original.length);
      assert.equal(settling.length, original.length);
      assert.ok(settling.every(a => a.frames[0].transform === "matrix(1, 0, 0, 1, 6, 0)" && a.frames[0].opacity === "0.6"));
      assert.ok(settling.every(a => a.options.duration === COLLECTION_PIVOT_MOTION.settle));
      target.dispatchEvent(input);
      assert.equal(animations.length, original.length * 2, "continuing input does not restart the settle");
    } else assert.ok(animations.every(a => a.cancelled));
    stop();
    assert.ok(animations.every(a => a.cancelled));
  }
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  animations.length = 0;
  playCollectionPivot(root, 1);
  toolbar.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  assert.ok(animations.every(a => a.cancelled), "keyboard entry from the fixed toolbar also settles content");
  animations.length = 0;
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  playCollectionPivot(root, 1);
  assert.equal(animations.length, 0, "background windows do not start an entrance");
});

test("queued restoration scroll events do not erase the return animation, while real scrolling still interrupts", t => {
  const { root, animations, window } = environment(t);
  const area = root.lastElementChild;
  area.scrollTop = 120;
  playCollectionPivot(root, -1);
  area.dispatchEvent(new window.Event("scroll"));
  assert.ok(animations.every(a => !a.cancelled));
  assert.equal(area.scrollTop, 120);
  area.scrollTop = 160;
  area.dispatchEvent(new window.Event("scroll"));
  assert.ok(animations.slice(0, 2).every(a => a.cancelled));
  assert.ok(animations.slice(2).every(a => a.options.duration === COLLECTION_PIVOT_MOTION.settle));
});

test("podcasts retain feather tokens while collection groups have a short flat entrance", t => {
  const { document } = environment(t);
  applyMotionTokens(document.documentElement);
  assert.equal(document.documentElement.style.getPropertyValue("--motion-browse"), `${BROWSE_MOTION.duration}ms`);
  assert.equal(document.documentElement.style.getPropertyValue("--motion-feather-scale"), `${BROWSE_MOTION.scale}`);
  const css = readFileSync("src/styles/motion.css", "utf8");
  assert.match(css, /\.podcast-queue-episode\s*\{\s*animation-duration: var\(--motion-browse\)/);
  assert.match(css, /@keyframes motion-feather-in\s*\{\s*from\s*\{[^}]*scale\(var\(--motion-feather-scale\)\)/);
  assert.ok(COLLECTION_PIVOT_MOTION.duration + MOTION_STAGGER.step * 2 < 300);
});

await build({ stdin: { contents: `export { useCollectionNavigation } from './src/hooks/useCollectionNavigation';
export { useCollectionPivot, useCollectionPanelMotion } from './src/hooks/useCollectionPivot';`, resolveDir: process.cwd(), loader: "tsx" },
  outfile: ".tmp/collection-pivot-hooks.js", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });

test("real navigation and Pivot hooks cancel rapid switches, preserve ordinary updates and respect reduced motion", async t => {
  const { window, document, animations } = environment(t);
  for (const key of ["window", "document", "HTMLElement", "Element", "Node"]) globalThis[key] = key === "window" ? window : window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const listeners = new Set();
  const media = { matches: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  window.matchMedia = () => media;
  const { createRoot } = await import("react-dom/client");
  const { useCollectionNavigation, useCollectionPivot } = await import("../.tmp/collection-pivot-hooks.js");
  let navigation;
  function Fixture() {
    navigation = useCollectionNavigation();
    const content = useRef(null);
    useCollectionPivot(content, navigation.history);
    return React.createElement("section", { ref: navigation.rootRef }, React.createElement("div", { ref: content, key: navigation.history.revision },
      React.createElement("div", { className: "collection-track-head" }, navigation.location.view),
      React.createElement("div", { className: "collection-track-scroll" }, "歌曲")));
  }
  const root = createRoot(document.getElementById("mount"));
  await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Fixture))));
  assert.equal(animations.length, 0, "StrictMode does not duplicate the outer page entrance");
  await act(async () => navigation.openIndex("songs"));
  await act(async () => navigation.openIndex("albums"));
  const current = animations.filter(a => !a.cancelled);
  assert.equal(current.length, 2, "rapid switches cancel previous effects");
  assert.ok(current.every(a => a.frames[0].transform.includes("-")));
  const count = animations.length;
  await act(async () => navigation.setPlaylistId("sample"));
  assert.equal(animations.length, count, "ordinary surface updates do not replay motion");
  await act(async () => { media.matches = true; listeners.forEach(fn => fn()); });
  assert.ok(animations.every(a => a.cancelled));
  await act(async () => { media.matches = false; listeners.forEach(fn => fn()); });
  assert.equal(animations.length, count, "disabling reduced motion does not replay the current page");
  await act(async () => navigation.openIndex("playlists", false));
  assert.equal(animations.length, count, "keyboard category selection is immediate");
  await act(async () => navigation.travel(-1));
  assert.equal(animations.length, count + 2, "history gets a visible return entrance without changing the restored surface");
  await act(async () => navigation.setQuery("歌曲"));
  assert.equal(animations.length, count + 2, "typing does not animate the results");
  await act(async () => navigation.openIndex("artists"));
  await act(async () => navigation.remember());
  assert.ok(animations.every(a => a.cancelled), "leaving the collection saves a static surface");
  await act(async () => root.unmount());
  assert.equal(listeners.size, 0);
  assert.ok(animations.every(a => a.cancelled));
});

test("detail panel changes animate in both directions without replaying the heading or ordinary updates", async t => {
  const { window, document, animations } = environment(t);
  for (const key of ["window", "document", "HTMLElement", "Element", "Node"]) globalThis[key] = key === "window" ? window : window[key];
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const { createRoot } = await import("react-dom/client");
  const { useCollectionPanelMotion } = await import("../.tmp/collection-pivot-hooks.js");
  let setTab, refresh;
  function Fixture() {
    const [tab, updateTab] = useState("overview"), [, update] = useState(0);
    setTab = updateTab; refresh = () => update(n => n + 1);
    const content = useRef(null);
    useCollectionPanelMotion(content, tab, ["overview", "albums", "songs"]);
    return React.createElement("section", { className: "collection-connected" }, React.createElement("h1", null, "艺术家"),
      React.createElement("div", { ref: content }, React.createElement("div", { className: "collection-track-scroll" }, tab)));
  }
  const root = createRoot(document.getElementById("mount"));
  await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Fixture))));
  assert.equal(animations.length, 0, "the parent page owns initial arrival");
  await act(async () => setTab("songs"));
  assert.equal(animations.filter(a => !a.cancelled).length, 1);
  assert.ok(animations.every(a => a.node.tagName !== "H1"));
  const count = animations.length;
  await act(async () => refresh());
  assert.equal(animations.length, count, "data refreshes do not restart the current panel");
  await act(async () => setTab("albums"));
  assert.equal(animations.filter(a => !a.cancelled).length, 1);
  assert.ok(animations.filter(a => !a.cancelled).every(a => a.frames[0].transform.includes("-22px")));
  await act(async () => root.unmount());
  assert.ok(animations.every(a => a.cancelled));
});
