import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
await build({ stdin: { contents: 'export { TranscriptPanel } from "./src/views/podcast/components/TranscriptPanel"; export { EpisodeBookmarks } from "./src/views/podcast/components/Bookmarks";', resolveDir: process.cwd(), loader: "ts" }, outfile: ".tmp/reading-ui-tests/view.mjs", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { TranscriptPanel, EpisodeBookmarks } = await import("../.tmp/reading-ui-tests/view.mjs");
const click = label => act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === label).click());
test("manual transcript reading pauses follow while current highlighting and explicit resume remain available", async () => {
  let scrolls = 0; window.HTMLElement.prototype.scrollIntoView = () => { scrolls++; };
  window.__TAURI_INTERNALS__ = { invoke: async command => command === "podcast_get_transcript" ? { language: "中文", cues: [0,10,20].map(start => ({ startSeconds: start, endSeconds: start + 10, text: "段落 " + start })), stale: false } : null };
  const root = createRoot(document.getElementById("root"));
  const props = { episodeId: "episode", active: true, progress: 12, revealed: true, onPlayAt() {} };
  try {
    await act(async () => root.render(React.createElement(TranscriptPanel, props)));
    const follow = document.querySelector('input[type="checkbox"]'); assert.equal(follow.checked, true);
    await act(async () => document.querySelector('ol').dispatchEvent(new window.WheelEvent("wheel", { bubbles: true })));
    assert.equal(follow.checked, false); const stopped = scrolls;
    await act(async () => root.render(React.createElement(TranscriptPanel, { ...props, progress: 25 })));
    assert.equal(scrolls, stopped); assert.match(document.querySelector('[aria-current="true"]').textContent, /段落 20/);
    await click("回到当前段落"); assert.equal(follow.checked, true); assert.ok(scrolls > stopped);
  } finally { await act(async () => root.unmount()); }
});
test("bookmark editing preserves its timestamp and delete undo restores the original identity", async () => {
  let items = [{ id: "bookmark", positionSeconds: 12, label: "原备注" }], edited, restored;
  window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    if (command === "podcast_update_bookmark") { edited = args; items = [{ ...items[0], label: args.label }]; }
    if (command === "podcast_remove_bookmark") items = [];
    if (command === "podcast_restore_bookmark") { restored = args.bookmark; items = [args.bookmark]; }
    return items;
  } };
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(EpisodeBookmarks, { episode: { id: "episode" }, position: 90, onPlayAt() {} })));
    await click("编辑"); const input = document.querySelector('[aria-label="编辑书签备注"]');
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "新备注"); input.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await click("保存备注"); assert.equal(edited.expectedLabel, "原备注"); assert.equal(edited.bookmarkId, "bookmark"); assert.equal(items[0].positionSeconds, 12);
    await click("删除"); assert.equal(document.querySelector("ol"), null);
    await click("撤销删除"); assert.deepEqual(restored, { id: "bookmark", positionSeconds: 12, label: "新备注" }); assert.match(document.querySelector("ol").textContent, /新备注/);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
