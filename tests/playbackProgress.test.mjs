import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";

const bootstrapDom = new JSDOM("<div></div>");
for (const key of ["window", "document", "Element", "HTMLElement", "Node"]) globalThis[key] = bootstrapDom.window[key];
const { createRoot } = await import("react-dom/client");
await build({ entryPoints: ["src/components/PlaybackProgress.tsx"], outfile: ".tmp/playback-progress-tests.js",
  bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { PlaybackProgress } = await import("../.tmp/playback-progress-tests.js");

async function fixture(initial = {}, applySeek = true) {
  const dom = new JSDOM('<div id="root"></div>');
  for (const key of ["window", "document", "Element", "HTMLElement", "Node"]) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById("root")), seeks = [], captures = new Set();
  let update;
  function Fixture() {
    const [props, setProps] = React.useState({ label: "同名媒体", mediaKey: "music:1", progress: 30, duration: 240, ...initial });
    update = patch => setProps(previous => ({ ...previous, ...patch }));
    return React.createElement(PlaybackProgress, { ...props, onSeek: value => { seeks.push(value); if (applySeek) update({ progress: value }); } });
  }
  await act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Fixture))));
  const input = document.querySelector("input");
  input.setPointerCapture = id => captures.add(id);
  input.hasPointerCapture = id => captures.has(id);
  input.releasePointerCapture = id => { captures.delete(id); input.dispatchEvent(new window.Event("lostpointercapture", { bubbles: true })); };
  return {
    input, seeks, captures,
    elapsed: () => document.querySelector(".zune-progress-time-start").textContent,
    remaining: () => document.querySelector(".zune-progress-time-end").textContent,
    update: async patch => { await act(() => update(patch)); },
    pointer: async (type, { id = 1, pointerType = "touch", primary = true, button = 0, target = input } = {}) => {
      const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button });
      Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType }, isPrimary: { value: primary } });
      await act(() => target.dispatchEvent(event));
    },
    change: async (value, type = "input") => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, String(value));
      await act(() => input.dispatchEvent(new window.Event(type, { bubbles: true })));
    },
    key: async key => {
      const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(() => input.dispatchEvent(event));
      return event;
    },
    close: async () => { await act(() => root.unmount()); dom.window.close(); },
  };
}

test("drag previews elapsed, remaining and fill without seeking or following live playback updates", async () => {
  const f = await fixture();
  try {
    await f.pointer("pointerdown");
    await f.change(120);
    assert.deepEqual(f.seeks, []);
    assert.equal(f.elapsed(), "2:00");
    assert.equal(f.remaining(), "-2:00");
    assert.equal(f.input.style.getPropertyValue("--range-progress"), "50%");
    assert.equal(f.input.getAttribute("aria-valuetext"), "2:00");
    await f.update({ progress: 35 });
    assert.equal(f.input.value, "120");
    await f.change(150);
    await f.pointer("pointerup", { target: document.body });
    assert.deepEqual(f.seeks, [150]);
    assert.equal(f.elapsed(), "2:30");
    assert.equal(f.captures.size, 0);
    await f.change(150, "change");
    await f.pointer("pointerup");
    assert.deepEqual(f.seeks, [150], "native final change and duplicate releases cannot seek twice");
    await f.update({ progress: 152 });
    assert.equal(f.elapsed(), "2:32");
  } finally { await f.close(); }
});

test("mouse, touch and pen clicks seek only when the primary pointer releases", async () => {
  const f = await fixture();
  try {
    for (const [index, pointerType] of ["mouse", "touch", "pen"].entries()) {
      await f.pointer("pointerdown", { pointerType });
      await f.change(70 + index);
      assert.equal(f.seeks.length, index);
      await f.pointer("pointerup", { id: 99 });
      assert.equal(f.seeks.length, index);
      await f.pointer("pointerup");
      assert.equal(f.seeks.at(-1), 70 + index);
    }
  } finally { await f.close(); }
});

test("holding the thumb without changing it never rewinds the advancing playback clock", async () => {
  const f = await fixture();
  try {
    await f.pointer("pointerdown"); await f.update({ progress: 40 });
    await f.pointer("pointerup");
    assert.deepEqual(f.seeks, []);
    assert.equal(f.elapsed(), "0:40");
  } finally { await f.close(); }
});

test("a later accessibility seek can return to the last pointer position", async () => {
  const f = await fixture({}, false);
  try {
    await f.pointer("pointerdown"); await f.change(120); await f.pointer("pointerup");
    assert.deepEqual(f.seeks, [120]);
    await new Promise(resolve => setTimeout(resolve, 5));
    await f.change(120, "change");
    assert.deepEqual(f.seeks, [120, 120]);
  } finally { await f.close(); }
});

test("keyboard and accessibility input retain immediate seeking and range focus", async () => {
  const f = await fixture();
  try {
    await act(() => f.input.focus());
    await f.key("ArrowRight"); await f.change(31);
    await f.key("Home"); await f.change(0);
    await f.key("End"); await f.change(240);
    await f.change(60, "change");
    assert.deepEqual(f.seeks, [31, 0, 240, 60]);
    assert.equal(document.activeElement, f.input);
  } finally { await f.close(); }
});

test("Escape, blur, hidden documents and capture loss cancel previews without a late seek", async () => {
  for (const reason of ["escape", "input-blur", "window-blur", "hidden", "capture-loss"]) {
    const f = await fixture();
    try {
      await act(() => f.input.focus());
      await f.pointer("pointerdown"); await f.change(120);
      if (reason === "escape") assert.equal((await f.key("Escape")).defaultPrevented, true);
      else if (reason === "input-blur") await act(() => f.input.blur());
      else if (reason === "hidden") await act(() => {
        Object.defineProperty(document, "hidden", { value: true, configurable: true });
        document.dispatchEvent(new window.Event("visibilitychange"));
      });
      else await act(() => (reason === "window-blur" ? window : f.input).dispatchEvent(new window.Event(
        reason === "window-blur" ? "blur" : "lostpointercapture", { bubbles: true })));
      assert.equal(f.elapsed(), "0:30", reason);
      await f.change(180); await f.pointer("pointerup");
      assert.deepEqual(f.seeks, [], reason);
      assert.equal(f.captures.size, 0);
    } finally { await f.close(); }
  }
});

test("pointer cancellation and a second finger discard the preview and allow the next drag", async () => {
  for (const reason of ["pointercancel", "second-finger"]) {
    const f = await fixture();
    try {
      await f.pointer("pointerdown"); await f.change(120);
      if (reason === "pointercancel") await f.pointer("pointercancel", { target: document.body });
      else await f.pointer("pointerdown", { id: 2, primary: false, target: document.body });
      await f.pointer("pointerup");
      assert.deepEqual(f.seeks, []);
      assert.equal(f.elapsed(), "0:30");
      await f.pointer("pointerdown", { id: 3 }); await f.change(90); await f.pointer("pointerup", { id: 3 });
      assert.deepEqual(f.seeks, [90]);
    } finally { await f.close(); }
  }
});

test("same-title media changes, duration changes and disabling cannot commit an old preview", async () => {
  for (const patch of [{ mediaKey: "music:2", progress: 10 }, { duration: 100 }, { disabled: true }]) {
    const f = await fixture();
    try {
      await f.pointer("pointerdown"); await f.change(120);
      await f.update(patch);
      assert.equal(f.elapsed(), patch.progress === 10 ? "0:10" : "0:30");
      await f.change(80); await f.pointer("pointerup");
      assert.deepEqual(f.seeks, []);
    } finally { await f.close(); }
  }
});

test("unavailable or non-finite progress remains safe and disabled ranges never seek", async () => {
  for (const initial of [{ duration: 0 }, { duration: Infinity }, { disabled: true }]) {
    const f = await fixture(initial);
    try {
      await f.pointer("pointerdown"); await f.change(40); await f.pointer("pointerup");
      assert.deepEqual(f.seeks, []);
    } finally { await f.close(); }
  }
  const f = await fixture({ progress: NaN });
  try { assert.equal(f.input.value, "0"); assert.equal(f.elapsed(), "0:00"); }
  finally { await f.close(); }
});

test("unmounting an active scrub releases capture without committing", async () => {
  const f = await fixture();
  await f.pointer("pointerdown"); await f.change(120);
  await f.close();
  assert.deepEqual(f.seeks, []);
  assert.equal(f.captures.size, 0);
});
