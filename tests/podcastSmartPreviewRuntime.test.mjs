import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
await build({ entryPoints: ["src/views/podcast/components/SmartListPreview.tsx"], outfile: ".tmp/smart-preview-tests/view.mjs", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { SmartListPreview } = await import("../.tmp/smart-preview-tests/view.mjs");
test("smart preview reports database totals and discards results for superseded conditions", async () => {
  const pending = [];
  window.__TAURI_INTERNALS__ = { invoke: (command, args) => new Promise(resolve => pending.push({ command, args, resolve })) };
  const root = createRoot(document.getElementById("root"));
  const rules = { filter: "all", sort: "newest", feedIds: [], maxAgeDays: null };
  try {
    await act(async () => root.render(React.createElement(SmartListPreview, { rules })));
    await act(async () => new Promise(resolve => setTimeout(resolve, 230)));
    await act(async () => root.render(React.createElement(SmartListPreview, { rules: { ...rules, filter: "saved" } })));
    await act(async () => new Promise(resolve => setTimeout(resolve, 230)));
    await act(async () => pending[1].resolve({ total: 501, episodes: [{ id: "a", title: "匹配节目" }], hasMore: true }));
    assert.match(document.querySelector('[role="status"]').textContent, /匹配 501 集/);
    assert.match(document.querySelector('.podcast-smart-preview').textContent, /超过待播上限/);
    await act(async () => pending[0].resolve({ total: 0, episodes: [], hasMore: false }));
    assert.match(document.querySelector('[role="status"]').textContent, /匹配 501 集/);
    assert.equal(pending[1].command, "podcast_preview_playlist"); assert.equal(pending[1].args.rules.filter, "saved");
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
