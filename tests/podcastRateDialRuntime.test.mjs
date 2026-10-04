import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
const dom = new JSDOM('<button id="outside">外部</button><div id="root"></div>', { url: "http://localhost" });
for (const key of ["window", "document", "HTMLElement"]) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
await build({ stdin: { contents: 'export {PodcastRateDial} from "./src/components/PodcastRateDial";', resolveDir: process.cwd(), loader: "tsx" }, outfile: ".tmp/podcastRateDialRuntime/view.mjs", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { PodcastRateDial } = await import("../.tmp/podcastRateDialRuntime/view.mjs");
const h = React.createElement;
const key = async (node, key) => act(() => node.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
const click = async node => act(() => node.click());
async function mount(t, component) {
  const root = createRoot(document.getElementById("root"));
  await act(() => root.render(h(React.StrictMode, null, component)));
  t.after(async () => { await act(() => root.unmount()); });
  return root;
}
test("rate dial bounds, keyboard, wheel focus and reset keep precise values", async t => {
  function Dial() { const [value, change] = useState(1.5); return h(PodcastRateDial, { value, onChange: change }); }
  await mount(t, h(Dial)); const dial = document.querySelector('[role="slider"]');
  const wheel = async deltaY => act(() => dial.dispatchEvent(new window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })));
  await wheel(-120); assert.equal(dial.getAttribute('aria-valuenow'), '1.5');
  dial.focus(); await wheel(-120); assert.equal(dial.getAttribute('aria-valuenow'), '1.75');
  await key(dial, 'ArrowLeft'); assert.equal(dial.getAttribute('aria-valuenow'), '1.5');
  await key(dial, 'End'); await key(dial, 'ArrowRight'); assert.equal(dial.getAttribute('aria-valuenow'), '3');
  await key(dial, 'Home'); await key(dial, 'ArrowDown'); assert.equal(dial.getAttribute('aria-valuenow'), '0.5');
  await click([...document.querySelectorAll('button')].find(b => b.textContent === '恢复原速')); assert.equal(dial.getAttribute('aria-valuenow'), '1');
});
test("dial drag respects its start, cancellation and inherited disabled state", async t => {
  let changed = [];
  const root = await mount(t, h(PodcastRateDial, { value: 1, onChange: value => changed.push(value) }));
  const dial = document.querySelector('[role="slider"]');
  dial.setPointerCapture = () => {}; dial.hasPointerCapture = () => true; dial.releasePointerCapture = () => {};
  const pointer = async (type, x, y) => act(() => {
    const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: 7 }); dial.dispatchEvent(event);
  });
  await pointer('pointerdown', 50, 50); assert.deepEqual(changed, []);
  await pointer('pointermove', 50, 14); assert.deepEqual(changed, [1.5]);
  await pointer('pointercancel', 50, 14); await pointer('pointermove', 50, 0); assert.deepEqual(changed, [1.5]);
  await act(() => root.render(h(React.StrictMode, null, h(PodcastRateDial, { value: 1, disabled: true, onChange: value => changed.push(value) }))));
  await key(dial, 'ArrowRight'); await pointer('pointerdown', 50, 50); await pointer('pointermove', 90, 50); assert.deepEqual(changed, [1.5]);
});
test.after(() => dom.window.close());
