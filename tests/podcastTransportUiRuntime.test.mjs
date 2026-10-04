import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
for (const key of ["window", "document", "HTMLElement"]) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
await build({ entryPoints: ["src/components/PodcastTransportOptions.tsx"], outfile: ".tmp/transport-ui-tests/view.mjs", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { PodcastTransportOptions } = await import("../.tmp/transport-ui-tests/view.mjs");
test("transport presets apply real deadlines, show scope and retain validated custom minutes", async () => {
  let timer;
  function Options() { const [value, setValue] = useState(null); timer = value; return React.createElement(PodcastTransportOptions, { rate: 1.5, timer: value, episodeId: "episode", rateScope: "show", onRate() {}, onTimer: setValue, onClose() {} }); }
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(Options)));
    assert.match(document.querySelector('.podcast-rate-scope').textContent, /本节目独立/);
    const before = Date.now();
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === "15 分钟").click());
    assert.equal(timer.kind, "deadline"); assert.ok(timer.deadlineAt >= before + 900000 && timer.deadlineAt <= Date.now() + 900000);
    assert.match(document.querySelector('[role="status"]').textContent, /剩余 15:00/);
    const input = document.querySelector('[aria-label="睡眠分钟"]'); assert.equal(input.value, "15");
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "241"); input.dispatchEvent(new window.Event("input", { bubbles: true })); });
    assert.equal([...document.querySelectorAll('button')].find(button => button.textContent === "设置定时").disabled, true);
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === "关闭定时").click());
    assert.equal(timer, null); assert.equal(document.querySelector('[role="status"]'), null);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
