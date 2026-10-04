import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
await build({ entryPoints: ["src/views/podcast/components/ListNavigator.tsx"], outfile: ".tmp/list-navigator-tests/view.mjs", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { ListNavigator } = await import("../.tmp/list-navigator-tests/view.mjs");
test("list search keeps the current selection and compact navigation selects a matching list", async () => {
  const lists = [{ id: "a", name: "正在收听", kind: "manual" }, { id: "b", name: "科技周末", kind: "smart" }];
  let selected;
  function Navigator() { const [id, setId] = useState("a"); selected = id; return React.createElement(ListNavigator, { lists, selected: id, onSelect: setId }); }
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Navigator))));
    const search = document.querySelector('input[type="search"]');
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(search, "科技"); search.dispatchEvent(new window.Event("input", { bubbles: true })); });
    assert.equal(selected, "a"); assert.equal(document.querySelectorAll("nav button").length, 1);
    const select = document.querySelector("select"); assert.equal(select.value, "a"); assert.equal(select.options.length, 2);
    await act(async () => { select.value = "b"; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
    assert.equal(selected, "b"); assert.equal(select.options.length, 1); assert.equal(document.querySelector('nav button').getAttribute("aria-pressed"), "true");
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
