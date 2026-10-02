import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

await build({ entryPoints: ["src/views/SettingsView.tsx"], outfile: ".tmp/settings-maintenance/view.js", bundle: true,
  packages: "external", format: "esm", platform: "browser", logLevel: "silent", plugins: [{ name: "native-stubs", setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/(core|event)$/ }, args => ({ path: args.path, namespace: "native" }));
    builder.onLoad({ filter: /.*/, namespace: "native" }, () => ({ contents: "export class Channel {} export const invoke = async (...args) => globalThis.__settingsNative?.(...args) ?? null; export const listen = async () => () => {};", loader: "js" }));
  } }] });
const { SettingsView } = await import("../.tmp/settings-maintenance/view.js");

test("library maintenance requires confirmation, preserves failure feedback and disables scanning clears", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const root = createRoot(document.getElementById("root"));
  let calls = 0;
  let fail = true;
  const props = { folders: [{ path: "test", name: "音乐" }], trackCount: 1, isScanning: false, onCancelScan() {}, scanNote: "",
    metadataProviders: [], onToggleMetadataProvider() {}, queueInsertMode: "next", adaptivePrevious: false, closeToTray: true,
    onQueueInsertModeChange() {}, onAdaptivePreviousChange() {}, onCloseToTrayChange() {}, onAddFolder() {}, onRescan() {},
    onClear: async () => { calls++; if (fail) throw Error("injected"); } };
  const button = label => [...document.querySelectorAll("button")].find(item => item.textContent === label);
  try {
    await act(async () => root.render(React.createElement(SettingsView, props)));
    const trigger = button("清空资料库");
    trigger.focus();
    await act(async () => trigger.click());
    assert.equal(calls, 0);
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.equal(document.activeElement.textContent, "取消");
    await act(async () => document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(calls, 1);
    assert.match(document.querySelector('[role="alert"]').textContent, /已有资料已保留/);
    assert.ok(document.querySelector('[role="dialog"]'));
    fail = false;
    await act(async () => document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => new Promise(resolve => setTimeout(resolve, 100)));
    assert.equal(calls, 2);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, trigger);
    await act(async () => root.render(React.createElement(SettingsView, { ...props, isScanning: true })));
    assert.equal(button("清空资料库").disabled, true);
    const privacy = button("隐私说明"); privacy.focus();
    await act(async () => privacy.click());
    assert.match(document.querySelector('[role="dialog"]').textContent, /不自动发送诊断记录/);
    assert.match(document.querySelector('[role="dialog"]').textContent, /SmartScreen/);
    const links = [];
    globalThis.__settingsNative = async (command, arguments_) => { links.push([command, arguments_.url]); };
    await act(async () => button("微软隐私声明").click());
    await act(async () => button("Edge 隐私白皮书").click());
    assert.deepEqual(links, [
      ["plugin:opener|open_url", "https://privacy.microsoft.com/privacystatement"],
      ["plugin:opener|open_url", "https://learn.microsoft.com/microsoft-edge/privacy-whitepaper#smartscreen"],
    ]);
    globalThis.__settingsNative = async () => { throw Error("injected opener failure"); };
    await act(async () => button("微软隐私声明").click());
    assert.match(document.querySelector('[role="dialog"] [role="alert"]').textContent, /无法打开隐私页面/);
    await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" })));
    await act(async () => new Promise(resolve => setTimeout(resolve, 100)));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, privacy);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of ["window", "document", "HTMLElement", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "__settingsNative"]) delete globalThis[key];
  }
});
