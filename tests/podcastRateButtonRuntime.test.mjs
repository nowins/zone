import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
for (const key of ["window", "document", "HTMLElement"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
await build({ stdin: { contents: 'export {PodcastRateButton} from "./src/components/PodcastRateButton";', resolveDir: process.cwd(), loader: "tsx" }, outfile: ".tmp/podcastRateButtonRuntime/view.mjs", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { PodcastRateButton } = await import("../.tmp/podcastRateButtonRuntime/view.mjs");
const h = React.createElement;
async function mount(t, props = {}) {
  function Rate() { const [value, onChange] = useState(props.value ?? 1); return h(PodcastRateButton, { ...props, value, onChange }); }
  const root = createRoot(document.getElementById("root"));
  await act(() => root.render(h(React.StrictMode, null, h(Rate))));
  t.after(async () => { await act(() => root.unmount()); });
  return document.querySelector("button");
}
test("rate clicks cycle from normal through fast rates and wrap to normal", async t => {
  const button = await mount(t);
  assert.equal(button.textContent, "1×");
  for (const value of [1.25, 1.5, 1.75, 2, 2.5, 3, 1, 1.25]) {
    await act(() => button.click()); assert.equal(button.textContent, `${value}×`);
    assert.match(button.getAttribute("aria-label"), new RegExp(`当前 ${value}×`));
  }
  assert.equal(document.querySelector('[role="dialog"]'), null);
});
test("existing slow or custom rates are displayed until explicitly advanced", async t => {
  const button = await mount(t, { value: 0.75, scope: "show" });
  assert.equal(button.textContent, "0.75×"); assert.match(button.title, /本节目/);
  button.focus(); await act(() => button.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -120, bubbles: true })));
  assert.equal(button.textContent, "0.75×");
  await act(() => button.click()); assert.equal(button.textContent, "1×");
});
test("disabled inherited/loading controls cannot mutate rate and never submit forms", async t => {
  const button = await mount(t, { disabled: true, value: 1.35 });
  assert.equal(button.type, "button"); await act(() => button.click()); assert.equal(button.textContent, "1.35×");
});
test.after(() => dom.window.close());
