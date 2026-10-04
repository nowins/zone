import assert from "node:assert/strict";
import test, { after } from "node:test";
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
after(() => dom.window.close());
test("restore previews the selected backup before merging, retains failures for retry and only then reports success", async () => {
  let confirms = 0;
  window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    if (command === "podcast_sync_status") return { folder: null };
    if (command === "podcast_get_backup_storage") return { directory: "Zone/podcast-backups", latest: null };
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
    if (command === "podcast_get_backup_storage") return { directory: "Zone/podcast-backups", latest: null };
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
  } finally { await act(async () => root.unmount()); }
});

test("one-click backups use native app storage, preserve prior status on failure and choose a path only for explicit export", async () => {
  const created = [], exported = [], opened = [];
  let latest = null, fail = false;
  window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    if (command === "podcast_sync_status") return { folder: null };
    if (command === "podcast_get_backup_storage") return { directory: "Zone/podcast-backups", latest };
    if (command === "podcast_create_backup") {
      created.push(args);
      if (fail) throw "磁盘空间不足";
      latest = { fileName: "本机资料.zonepodcast", createdAt: 1000, audioCount: args.includeAudio ? 2 : 0 };
      return { ...latest, locationToken: "managed" };
    }
    if (command === "podcast_export_backup") { exported.push(args); return { fileName: "导出资料.zonepodcast", audioCount: 2, locationToken: "external" }; }
    if (command === "podcast_open_managed_backup_folder" || command === "podcast_open_backup_folder") opened.push({ command, args });
  } };
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(TransferActions)));
    assert.match(document.querySelector('.podcast-backup-status').textContent, /尚未创建/);
    await click("立即备份");
    assert.equal(created[0].includeAudio, false);
    assert.equal(exported.length, 0);
    assert.match(document.querySelector('.podcast-backup-status').textContent, /最近备份/);
    await act(async () => document.querySelector('[role="switch"][aria-label="包含已下载音频"]').click());
    assert.equal(created.length, 1);
    fail = true; await click("立即备份");
    assert.match(document.querySelector('.podcast-transfer-actions > [role="alert"]').textContent, /磁盘空间不足/);
    assert.match(document.querySelector('.podcast-backup-status').textContent, /最近备份/);
    fail = false; await click("立即备份");
    assert.equal(created[2].includeAudio, true);
    assert.match(document.querySelector('.podcast-transfer-actions > [role="status"]').textContent, /含 2 个音频/);
    await click("打开备份目录");
    assert.equal(opened[0].command, "podcast_open_managed_backup_folder");
    assert.ok(!opened[0].args || Object.keys(opened[0].args).length === 0);
    document.querySelector('.podcast-backup-export').open = true;
    await click("导出资料副本"); await click("打开导出位置");
    assert.equal(exported.length, 1);
    assert.equal(opened[1].args.token, "external");
  } finally { await act(async () => root.unmount()); }
});
