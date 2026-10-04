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
await build({ stdin: { contents: 'export {Select} from "./src/components/Select"; export {Dialog} from "./src/components/Dialog";', resolveDir: process.cwd(), loader: "tsx" }, outfile: ".tmp/themedSelectRuntime/view.mjs", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { Select, Dialog } = await import("../.tmp/themedSelectRuntime/view.mjs");
const h = React.createElement;
const key = async (node, key) => act(() => node.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
const click = async node => act(() => node.click());
async function mount(t, component) {
  const root = createRoot(document.getElementById("root"));
  await act(() => root.render(h(React.StrictMode, null, component)));
  t.after(async () => { await act(() => root.unmount()); });
  return root;
}
function Selector({ disabled = false }) {
  const [value, change] = useState("a");
  return h(Select, { value, onValueChange: change, disabled, "aria-label": "筛选" },
    h('option', { value: "a" }, "全部"), h('option', { value: "x", disabled: true }, "不可选"), h('option', { value: "b" }, "已下载"));
}
test("custom select keeps focus, skips disabled options and commits with keyboard", async t => {
  await mount(t, h(Selector));
  const trigger = document.querySelector('[role="combobox"]'); trigger.focus();
  await key(trigger, "ArrowDown"); assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  await key(trigger, "ArrowDown");
  assert.equal(document.getElementById(trigger.getAttribute('aria-activedescendant')).dataset.value, 'b');
  assert.equal(trigger.dataset.value, 'a', 'navigation does not change selection');
  await key(trigger, "Enter"); assert.equal(trigger.dataset.value, 'b'); assert.equal(document.activeElement, trigger);
  await key(trigger, " "); await key(trigger, "Home"); await key(trigger, "Escape");
  assert.equal(trigger.dataset.value, 'b', 'Escape cancels pending navigation');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});
test("select pointer choice, type search, outside dismissal and disable are safe", async t => {
  const root = await mount(t, h(Selector)); const trigger = document.querySelector('[role="combobox"]'); trigger.focus();
  await key(trigger, "已"); assert.equal(document.getElementById(trigger.getAttribute('aria-activedescendant')).dataset.value, 'b');
  await click(document.querySelector('[role="option"][data-value="b"]')); assert.equal(trigger.dataset.value, 'b');
  await click(trigger); await act(() => document.getElementById('outside').dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  await click(trigger); await act(() => root.render(h(React.StrictMode, null, h(Selector, { disabled: true }))));
  assert.equal(trigger.disabled, true); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});
test("a select inside a form label commits without reopening or submitting", async t => {
  let submits = 0;
  await mount(t, h('form', { onSubmit: event => { event.preventDefault(); submits++; } }, h('label', null, '筛选', h(Selector))));
  const trigger = document.querySelector('[role="combobox"]'); await click(trigger);
  await click(document.querySelector('[role="option"][data-value="b"]'));
  assert.equal(trigger.dataset.value, 'b'); assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assert.equal(submits, 0);
});
test("keyboard navigation scrolls only the popup and never its outer reading page", async t => {
  let ancestorScrolls = 0;
  const previous = window.HTMLElement.prototype.scrollIntoView;
  window.HTMLElement.prototype.scrollIntoView = () => { ancestorScrolls++; document.dispatchEvent(new window.Event('scroll')); };
  t.after(() => { window.HTMLElement.prototype.scrollIntoView = previous; });
  await mount(t, h(Selector)); const trigger = document.querySelector('[role="combobox"]'); trigger.focus();
  await key(trigger, 'ArrowDown'); const menu = document.querySelector('[role="listbox"]');
  Object.defineProperty(menu, 'clientHeight', { value: 60 });
  const last = menu.querySelector('[data-value="b"]');
  Object.defineProperty(last, 'offsetTop', { value: 200 }); Object.defineProperty(last, 'offsetHeight', { value: 34 });
  await key(trigger, 'ArrowDown');
  assert.equal(ancestorScrolls, 0); assert.equal(menu.scrollTop, 174); assert.equal(trigger.getAttribute('aria-expanded'), 'true');
});
test("dropdown flips upward inside a dialog and first Escape dismisses only its list", async t => {
  let closed = 0;
  await mount(t, h(Dialog, { titleId: "title", title: "设置", kicker: "播客", onCancel: () => closed++, onSubmit: () => {} }, h(Selector)));
  const trigger = document.querySelector('[role="combobox"]');
  trigger.getBoundingClientRect = () => ({ left: 990, top: 700, bottom: 736, width: 100 });
  await click(trigger); const menu = document.querySelector('[role="listbox"]');
  assert.equal(menu.style.top, 'auto'); assert.equal(menu.style.left, '832px');
  await key(trigger, 'Escape'); assert.equal(closed, 0); await key(trigger, 'Escape'); assert.equal(closed, 1);
});
test.after(() => dom.window.close());
