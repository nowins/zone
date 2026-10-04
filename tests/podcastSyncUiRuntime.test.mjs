import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.setInterval = () => 1; window.clearInterval = () => {};
const { createRoot } = await import("react-dom/client");
await build({ entryPoints: ["src/views/podcast/components/SyncSettings.tsx"], outfile: ".tmp/sync-ui-tests/view.mjs", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { PodcastSyncSettings } = await import("../.tmp/sync-ui-tests/view.mjs");

test("partial sync reports the actual devices and clears its error only after a successful retry", async () => {
  const calls = [];
  const partial = { folder: "\\\\?\\D:\\同步", lastSynced: 100, syncing: false, error: "部分设备暂未合并", report: { devicesRead: 2, failedDevices: 1, changed: true } };
  window.__TAURI_INTERNALS__ = { invoke: async command => { calls.push(command); return command === "podcast_sync_now" ? { ...partial, error: null, report: { devicesRead: 3, failedDevices: 0, changed: false } } : partial; } };
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(PodcastSyncSettings))));
    assert.match(document.body.textContent, /同步需要处理/);
    assert.match(document.body.textContent, /已检查 2 台其他设备/);
    assert.match(document.body.textContent, /1 台暂未合并/);
    assert.equal(document.querySelector('.podcast-sync-path').textContent, "D:\\同步");
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === "重试同步").click());
    assert.equal(calls.at(-1), "podcast_sync_now");
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.match(document.body.textContent, /已检查 3 台其他设备 · 资料无变化/);
    assert.match(document.querySelector('[role="status"]').textContent, /已同步/);
    let finishChoice, finishStop;
    window.__TAURI_INTERNALS__.invoke = async command => {
      calls.push(command);
      if (command === "podcast_choose_sync_folder") return new Promise(resolve => { finishChoice = resolve; });
      if (command === "podcast_stop_sync") return new Promise(resolve => { finishStop = resolve; });
      return partial;
    };
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === "更换同步目录").click());
    await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.match(document.querySelector('.podcast-sync-status').textContent, /正在选择同步目录/);
    assert.doesNotMatch(document.querySelector('.podcast-sync-status').textContent, /正在同步$/);
    await act(async () => finishChoice({ ...partial, error: null }));
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === "停止同步").click());
    assert.match(document.querySelector('.podcast-sync-status').textContent, /正在停止同步/);
    await act(async () => finishStop({ folder: null, syncing: false }));
    assert.match(document.querySelector('.podcast-sync-status').textContent, /同步未开启/);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
