import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
await build({ entryPoints: ["src/views/podcast/components/FeedPicker.tsx"], outfile: ".tmp/feed-picker-tests/view.mjs", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { FeedPicker } = await import("../.tmp/feed-picker-tests/view.mjs");

test("filtered programme selection preserves hidden members and reports the full selection", async () => {
  const feeds = ["新闻", "科技", "历史"].map(title => ({ id: title, title }));
  let ids;
  function Picker() {
    const [selected, setSelected] = useState(["历史", "已取消关注"]); ids = selected;
    return React.createElement(FeedPicker, { feeds, selected, onChange: setSelected });
  }
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Picker))));
    const search = document.querySelector('input[type="search"]');
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(search, "科技"); search.dispatchEvent(new window.Event("input", { bubbles: true })); });
    assert.equal(document.querySelectorAll('input[type="checkbox"]').length, 1);
    await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "选中可见节目").click());
    assert.deepEqual(ids, ["历史", "已取消关注", "科技"]);
    assert.equal(document.querySelector('[role="status"]').textContent, "已选 2 / 3");
    await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "取消可见选择").click());
    assert.deepEqual(ids, ["历史", "已取消关注"]);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
