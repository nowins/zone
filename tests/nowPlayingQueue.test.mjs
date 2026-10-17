import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { build } from "esbuild";

await build({ entryPoints: ["src/components/NowPlayingQueue.tsx"], outfile: ".tmp/now-playing-queue.mjs",
  bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { NowPlayingQueue } = await import("../.tmp/now-playing-queue.mjs");
const h = React.createElement;
const tracks = Array.from({ length: 10000 }, (_, index) => ({ id: `track-${index}`, title: `歌曲 ${index}`, artist: "艺术家" }));

function environment(t) {
  const dom = new JSDOM('<body><button id="before">前一个</button><div id="root"></div><button id="after">后一个</button></body>',
    { url: "http://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "HTMLElement", "Element", "Node", "KeyboardEvent"]) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let observed = 0;const observers = new Set();
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; }
    observe() { observed++;observers.add(this); } disconnect() { observed--;observers.delete(this); } };
  Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return this.classList.contains("now-panel-tracks") ? 280 : 0; } });
  window.HTMLElement.prototype.getBoundingClientRect = function () { return { width: 250, height: this.matches(".now-queue-track") ? 54 : 280, top: 0, left: 0, right: 250, bottom: 280 }; };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const root = createRoot(document.getElementById("root")), plays = [];
  t.after(async () => { await act(async () => root.unmount());dom.window.close(); });
  return { root, plays, get observed() { return observed; },
    async render(items = tracks, activeTrackId = items[0]?.id ?? null) {
      await act(async () => root.render(h(React.StrictMode, null, h(NowPlayingQueue, { tracks: items, activeTrackId, onPlay: track => plays.push(track) }))));
    },
    async scroll(top) { await act(async () => { const area = document.querySelector(".now-panel-tracks");area.scrollTop = top;area.dispatchEvent(new window.Event("scroll")); }); },
    async focus(index) { await act(async () => document.querySelector(`[data-now-queue-index="${index}"]`).focus()); },
    async tab(shiftKey = false) { const event = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, shiftKey });
      await act(async () => document.activeElement.dispatchEvent(event));return event; },
    async resize() { await act(async () => { for (const observer of observers) observer.callback([]); }); },
  };
}

test("large now-playing queues keep DOM bounded, full scroll geometry and exact source clicks", async t => {
  const env = environment(t);await env.render();
  const buttons = () => [...document.querySelectorAll("[data-now-queue-index]")];
  assert.ok(buttons().length < 20);
  assert.equal(buttons()[0].dataset.nowQueueIndex, "0");
  const totalHeight = () => [...document.querySelector(".now-panel-upcoming").children].reduce((sum, node, index) => sum + (index ? 2 : 0)
    + (node.matches('[role="listitem"]') ? 54 : Number.parseFloat(node.style.height)), 0);
  assert.equal(totalHeight(), tracks.length * 56 - 2);
  await env.scroll(560000 - 280);
  assert.equal(buttons().at(-1).dataset.nowQueueIndex, "9999");
  assert.equal(buttons().at(-1).parentElement.getAttribute("aria-posinset"), "10000");
  assert.equal(buttons().at(-1).parentElement.getAttribute("aria-setsize"), "10000");
  assert.ok(buttons().length < 20);assert.equal(totalHeight(), tracks.length * 56 - 2);
  await act(async () => buttons().at(-1).click());
  assert.equal(env.plays[0], tracks[9999]);
  assert.equal(tracks[0].id, "track-0");assert.equal(tracks.at(-1).id, "track-9999");
});

test("Tab crosses virtual boundaries and mouse scrolling retains the focused queue owner", async t => {
  const env = environment(t);await env.render();await env.focus(0);
  for (let index = 1; index <= 30; index++) {
    assert.equal((await env.tab()).defaultPrevented, true);
    assert.equal(document.activeElement.dataset.nowQueueIndex, String(index));
  }
  await env.scroll(560000 - 280);
  assert.equal(document.activeElement.dataset.nowQueueIndex, "30");
  assert.ok(document.querySelectorAll("[data-now-queue-index]").length < 22);
  assert.equal((await env.tab()).defaultPrevented, true);
  assert.equal(document.activeElement.dataset.nowQueueIndex, "31");
  assert.equal((await env.tab(true)).defaultPrevented, true);
  assert.equal(document.activeElement.dataset.nowQueueIndex, "30");
  await env.scroll(0);await env.focus(0);
  assert.equal((await env.tab(true)).defaultPrevented, false, "first row must allow focus to leave backwards");
  await env.scroll(560000 - 280);await env.focus(9999);
  assert.equal((await env.tab()).defaultPrevented, false, "last row must allow focus to leave forwards");
  await act(async () => document.getElementById("after").focus());
  assert.equal(document.querySelector('[data-now-queue-index="30"]'), null);
});

test("small queues retain duplicates, current markers and cleanup across queue replacements", async t => {
  const env = environment(t);const items = [tracks[0], tracks[0], tracks[2]];await env.render(items);
  assert.equal(document.querySelectorAll(".now-panel-current").length, 2);
  await act(async () => document.querySelector('[data-now-queue-index="1"]').click());
  assert.equal(env.plays[0], tracks[0]);assert.equal(env.observed, 0);
  await env.render();assert.equal(env.observed, 1);await env.resize();
  await env.render([]);assert.equal(env.observed, 0);
  assert.match(document.querySelector(".now-panel-empty").textContent, /暂无播放/);
  assert.equal(document.querySelectorAll("[data-now-queue-index]").length, 0);
});

test("a remote current-track change reveals its row without stealing keyboard focus", async t => {
  const env = environment(t);await env.render();await env.focus(0);
  const owner = document.activeElement;
  await env.render(tracks, tracks[9999].id);
  assert.equal(document.querySelector('[data-now-queue-index="9999"]').getAttribute("aria-current"), "true");
  assert.equal(document.activeElement, owner);
  assert.ok(document.querySelectorAll("[data-now-queue-index]").length < 22);
  assert.ok(document.querySelector(".now-panel-tracks").scrollTop > 550000);
});
