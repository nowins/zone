import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
const dom = new JSDOM('<button id="outside">外部</button><div id="root"></div>', { url: "http://localhost" });
for (const key of ["window", "document", "HTMLElement"]) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
await build({ stdin: { contents: 'export {DiscoveryInfo,DiscoveryShelf} from "./src/views/podcast/components/ShowCards";', resolveDir: process.cwd(), loader: "tsx" }, outfile: ".tmp/podcastDiscoveryInfoRuntime/view.mjs", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { DiscoveryInfo, DiscoveryShelf } = await import("../.tmp/podcastDiscoveryInfoRuntime/view.mjs");
const h = React.createElement;
const key = async (node, key) => act(() => node.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
const click = async node => act(() => node.click());
async function mount(t, component) {
  const root = createRoot(document.getElementById("root"));
  await act(() => root.render(h(React.StrictMode, null, component)));
  t.after(async () => { await act(() => root.unmount()); });
  return root;
}
test("discovery source is secondary; refresh retains the snapshot date until new data arrives", async t => {
  let refreshes = 0;
  await mount(t, h('div', null, h(DiscoveryInfo, { sourceLabel: 'XYZRank 中文榜 · 缓存', fetchedAt: 1234000, refreshing: false, onRefresh: () => refreshes++ }),
    h(DiscoveryShelf, { state: 'ready', shows: [], feeds: [], openingId: null, onOpen() {}, onRetry() {} })));
  assert.equal(document.querySelector('.podcast-discovery-source'), null);
  assert.equal(document.body.textContent.includes('刷新榜单'), false);
  const trigger = document.querySelector('[aria-label="榜单信息"]'); trigger.focus(); await click(trigger);
  const date = document.querySelector('time').dateTime; await click([...document.querySelectorAll('button')].find(b => b.textContent === '更新榜单'));
  assert.equal(refreshes, 1); assert.equal(document.querySelector('time').dateTime, date);
  assert.match(document.querySelector('.podcast-discovery-source').textContent, /XYZRank.*缓存/);
});
test.after(() => dom.window.close());
