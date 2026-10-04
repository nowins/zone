import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
for (const key of ["window", "document", "HTMLElement", "localStorage"]) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { createRoot } = await import("react-dom/client");
await build({ entryPoints: ["src/views/podcast/components/TransferActions.tsx"], outfile: ".tmp/transfer-ui-tests/view.mjs", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { TransferActions } = await import("../.tmp/transfer-ui-tests/view.mjs");
const click = label => act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === label).click());
test("restore previews the selected backup before merging, retains failures for retry and only then reports success", async () => {
  let confirms = 0;
  window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    if (command === "podcast_sync_status") return { folder: null };
    if (command === "podcast_choose_restore_backup") return { token: "selected", fileName: "试听资料.zonepodcast", createdAt: 1000, feeds: 2, episodes: 50, progress: 3, lists: 1, groups: 2, bookmarks: 4, audioCount: 2, audioBytes: 2048 };
    if (command === "podcast_confirm_restore_backup") { confirms++; assert.equal(args.token, "selected"); if (confirms === 1) throw "空间不足"; return { frontend: {}, counts: { mergedRecords: 5, retainedRecords: 7, audioCount: 2 } }; }
  } };
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(TransferActions)));
    await click("恢复资料"); assert.equal(confirms, 0); assert.match(document.querySelector('[role="dialog"]').textContent, /试听资料/); assert.match(document.querySelector('dl').textContent, /单集50/);
    await click("确认合并"); assert.equal(confirms, 1); assert.match(document.querySelector('[role="dialog"]').textContent, /空间不足/);
    await click("重试合并"); assert.equal(confirms, 2);
    assert.match(document.querySelector('.podcast-transfer-actions > [role="status"]').textContent, /已合并 5 条资料，保留已有 7 条，2 个音频/);
  } finally { await act(async () => root.unmount()); }
});
test("failed subscription retry sends only failed URLs and combines the real result", async () => {
  let retry;
  window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    if (command === "podcast_sync_status") return { folder: null };
    if (command === "podcast_import_opml") return { imported: 1, skipped: 2, failures: ["节目暂时不可用"], failedUrls: ["https://example.com/rss"] };
    if (command === "podcast_retry_import") { retry = args.urls; return { imported: 1, skipped: 0, failures: [], failedUrls: [] }; }
  } };
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(TransferActions)));
    await click("导入订阅"); await click("重试失败项");
    assert.deepEqual(retry, ["https://example.com/rss"]);
    assert.match(document.querySelector('.podcast-transfer-actions > [role="status"]').textContent, /已导入 2 个节目，已有 2 个，失败 0 个/);
    assert.equal(document.querySelector('details.podcast-import-failures'), null);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
