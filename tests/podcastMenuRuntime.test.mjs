import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { build } from "esbuild";

await build({ entryPoints: ["src/components/PodcastEpisodeContextMenu.tsx"], outfile: ".tmp/podcast-menu-runtime.js", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const dom = new JSDOM('<body><button id="outside">外部</button><div id="root"></div></body>', { pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "KeyboardEvent", "getComputedStyle"]) globalThis[key] = dom.window[key];
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { PodcastEpisodeContextMenu } = await import("../.tmp/podcast-menu-runtime.js");

test("podcast menus focus after becoming visible, skip disabled items and survive internal scrolling", async t => {
  const outside = document.getElementById("outside");
  const nativeFocus = HTMLElement.prototype.focus;
  const nativeRect = HTMLElement.prototype.getBoundingClientRect;
  const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return this.matches('[role="menu"]') ? 264 : 0; } });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return this.matches('[role="menu"]') ? 234 : 0; } });
  HTMLElement.prototype.focus = function (options) {
    // Model the browser's refusal to focus descendants of a hidden menu.
    if (this.closest('[role="menu"]')?.style.visibility === "hidden") return;
    nativeFocus.call(this, options);
  };
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.matches('[role="menu"]') ? { width: 180.4, height: 150.7 } : nativeRect.call(this);
  };
  const root = createRoot(document.getElementById("root"));
  t.after(async () => {
    await act(async () => root.unmount());
    HTMLElement.prototype.focus = nativeFocus;
    HTMLElement.prototype.getBoundingClientRect = nativeRect;
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", widthDescriptor);
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", heightDescriptor);
  });
  outside.focus();
  let closed = 0;
  const nothing = () => {};
  await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(PodcastEpisodeContextMenu, {
    menu: { x: 1000.4, y: 740.4, episode: { id: "episode", title: "测试单集", feedTitle: "测试节目", progressSeconds: 30, completed: false }, returnFocus: outside },
    downloading: true, updatingPlayed: false, queueState: "queued", onClose: () => closed++,
    onPlay: nothing, onQueue: nothing, onTogglePlayed: nothing, onDownload: nothing, onShare: nothing,
  }))));
  const menu = document.querySelector('[role="menu"]');
  assert.equal(menu.style.visibility, "visible");
  assert.equal(menu.style.left, "748px"); assert.equal(menu.style.top, "522px");
  assert.equal(document.activeElement.textContent.trim(), "继续收听");
  const key = async value => act(async () => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
  await key("End"); assert.equal(document.activeElement.textContent.trim(), "分享");
  await key("ArrowUp"); assert.equal(document.activeElement.textContent.trim(), "标记为已播放");
  await key("Home"); assert.equal(document.activeElement.textContent.trim(), "继续收听");
  await act(async () => menu.dispatchEvent(new window.Event("scroll")));
  assert.equal(closed, 0);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 920 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 620 });
  await act(async () => window.dispatchEvent(new window.Event("resize")));
  assert.equal(menu.style.left, "644px"); assert.equal(menu.style.top, "374px");
  await act(async () => document.dispatchEvent(new window.Event("scroll")));
  assert.equal(closed, 1);
  await key("Escape");
  await act(async () => new Promise(resolve => window.requestAnimationFrame(resolve)));
  assert.equal(closed, 2); assert.equal(document.activeElement, outside);
});
