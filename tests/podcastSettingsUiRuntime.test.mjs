import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
for (const key of ["window", "document", "HTMLElement"]) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
await build({ entryPoints: ["src/views/podcast/components/SettingsDialog.tsx"], outfile: ".tmp/settings-ui-tests/view.mjs", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { PodcastSettingsDialog } = await import("../.tmp/settings-ui-tests/view.mjs");
const defaults = { autoDownloadCount: 0, cleanupPlayed: false, storageLimitMb: 0, playbackRate: 1.5, introSeconds: 10, outroSeconds: 0, backwardSeconds: 15, forwardSeconds: 30, oldestFirst: false, normalizeVoice: false, trimSilence: false, inheritPlayback: true };
test("inherited values show effective defaults and tab switching preserves independent drafts", async () => {
  let saved;
  window.__TAURI_INTERNALS__ = { invoke: async (command, args) => { if (command === "podcast_get_preferences") return args.feedId ? { ...defaults, introSeconds: 120, playbackRate: 3, autoDownloadCount: 3 } : defaults; saved = args; } };
  const root = createRoot(document.getElementById("root"));
  const click = async label => act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === label).click());
  try {
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(PodcastSettingsDialog, { feedId: "feed", title: "节目", onClose() {} }))));
    assert.equal(document.querySelector('[aria-label="跳过片头"]').value, "10");
    assert.equal(document.querySelector('[aria-label="节目播放速度"]').value, "1.5");
    assert.equal(document.querySelector('[aria-label="跳过片头"]').disabled, true);
    await act(async () => document.querySelector('input[type="checkbox"]').click());
    assert.equal(document.querySelector('[aria-label="跳过片头"]').value, "120");
    await click("下载与清理");
    const select = document.querySelector('[aria-label="自动下载最新单集"]');
    await act(async () => { select.value = "5"; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
    await click("播放偏好");
    assert.equal(document.querySelector('[aria-label="跳过片头"]').value, "120");
    await act(async () => document.querySelector('form').dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(saved.feedId, "feed"); assert.equal(saved.preferences.autoDownloadCount, 5);
    assert.equal(saved.preferences.introSeconds, 120); assert.equal(saved.preferences.inheritPlayback, false);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
