import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { build } from "esbuild";
import { useAppHotkeys } from "../.tmp/visualizer-tests/hooks/useAppHotkeys.js";
import { useEntranceCompletion } from "../.tmp/visualizer-tests/hooks/useEntranceCompletion.js";
import { useMountedRef } from "../.tmp/visualizer-tests/hooks/useMountedRef.js";

await build({ entryPoints: ["src/components/Dialog.tsx"], outfile: ".tmp/dialog-tests/view.js",
  bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { Dialog } = await import("../.tmp/dialog-tests/view.js");

const dom = new JSDOM('<body><button id="opener">打开</button><div id="root"></div></body>');
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "KeyboardEvent", "getComputedStyle"]) {
  globalThis[key] = key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
async function mount(component, context) {
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(h(React.StrictMode, null, component)));
  context.after(async () => { await act(async () => root.unmount()); });
  return root;
}
function key(target, value, options = {}) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}
test("global transport shortcuts respect buttons, menus, dialogs and composition", async t => {
  let played = 0;
  function Probe() {
    useAppHotkeys({ onTogglePlay: () => played++, onPrevious() {}, onNext() {}, onVolumeUp() {}, onVolumeDown() {} });
    return h("button", { id: "action" }, "动作");
  }
  await mount(h(Probe), t);
  assert.equal(key(document.getElementById("action"), " ").defaultPrevented, false);
  key(document.body, " ", { isComposing: true });
  assert.equal(played, 0);
  const menu = document.createElement("div"); menu.setAttribute("role", "menu"); document.body.append(menu);
  key(document.body, " "); assert.equal(played, 0); menu.remove();
  key(document.body, " "); assert.equal(played, 1);
});
test("StrictMode replay keeps the mounted guard live and finishes entrance", async t => {
  let guard;
  function Probe() {
    guard = useMountedRef();
    return h("div", { id: "status" }, String(useEntranceCompletion(true, 10)));
  }
  const root = await mount(h(Probe), t);
  assert.equal(guard.current, true);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  assert.equal(document.getElementById("status").textContent, "true");
  await act(async () => root.render(null));
  assert.equal(guard.current, false);
});
test("modal traps Tab, isolates background and restores opener after unmount", async t => {
  const opener = document.getElementById("opener"); opener.focus();
  const root = await mount(h(Dialog, { titleId: "title", kicker: "测试", title: "对话框", onCancel() {}, onSubmit() {} },
    h("button", { id: "first" }, "第一个"), h("button", { id: "last" }, "最后一个")), t);
  assert.equal(document.activeElement.id, "first");
  assert.equal(opener.hasAttribute("inert"), true);
  key(document.activeElement, "Tab", { shiftKey: true });
  assert.equal(document.activeElement.id, "last");
  key(document.activeElement, "Tab");
  assert.equal(document.activeElement.id, "first");
  await act(async () => root.render(null));
  assert.equal(document.activeElement, opener);
  assert.equal(opener.hasAttribute("inert"), false);
});
