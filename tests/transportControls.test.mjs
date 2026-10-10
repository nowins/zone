import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";

const bootstrapDom = new JSDOM('<div></div>');
for (const key of ["window", "document", "Element", "HTMLElement", "Node"]) globalThis[key] = bootstrapDom.window[key];
const { createRoot } = await import("react-dom/client");

await build({ entryPoints: ["src/components/TransportControls.tsx", "src/hooks/useNowPlayingFullscreen.ts"],
  outdir: ".tmp/transport-controls-tests", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { TransportControls, VolumeControl } = await import("../.tmp/transport-controls-tests/components/TransportControls.js");
const { useNowPlayingFullscreen } = await import("../.tmp/transport-controls-tests/hooks/useNowPlayingFullscreen.js");

function setup() {
  const dom = new JSDOM('<div id="root"></div>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  for (const key of ["Element", "HTMLElement", "Node"]) globalThis[key] = dom.window[key];
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById("root"));
  return { root, close: async () => { await act(() => root.unmount()); dom.window.close(); } };
}

test("repeat renders distinct off, list and single-track states without changing playback actions", async () => {
  const env = setup();
  let plays = 0;
  let repeats = 0;
  const noop = () => {};
  try {
    for (const [repeat, title] of [["off", "关闭循环"], ["all", "列表循环"], ["one", "单曲循环"]]) {
      await act(() => env.root.render(React.createElement(TransportControls, {
        trackAvailable: true, isPlaying: false, shuffle: false, repeat,
        onQueue: noop, onLyrics: noop, onFullscreen: noop, onRepeat: () => repeats++, onShuffle: noop,
        onPrevious: noop, onPlayPause: () => plays++, onNext: noop,
      })));
      const button = document.querySelector(`[title="${title}"]`);
      assert.equal(button.getAttribute("aria-pressed"), String(repeat !== "off"));
      assert.equal(Boolean(button.querySelector(".lucide-repeat1")), repeat === "one");
      await act(() => button.click());
      await act(() => document.querySelector('[title="播放"]').click());
      assert.ok(document.querySelector('[title="显示正在播放列表"]'));
    }
    assert.equal(plays, 3);
    assert.equal(repeats, 3);
  } finally { await env.close(); }
});

test("volume wheel handles bursts, direction, fine deltas and limits without scrolling the page", async () => {
  const env = setup();
  const values = [];
  let outerScrolls = 0;
  window.addEventListener("wheel", () => outerScrolls++);
  try {
    await act(() => env.root.render(React.createElement(VolumeControl, { volume: 0.8, onVolume: v => values.push(v) })));
    const label = document.querySelector("label");
    const wheel = (deltaY, extra = {}) => {
      const event = new window.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true, ...extra });
      label.dispatchEvent(event);
      return event;
    };
    assert.equal(wheel(-100).defaultPrevented, true);
    wheel(-100);
    assert.ok(Math.abs(values.at(-1) - 0.9) < 1e-8, "bursts use the latest value before React rerenders");
    for (let i = 0; i < 8; i++) wheel(-100);
    assert.equal(values.at(-1), 1);
    for (let i = 0; i < 24; i++) wheel(100);
    assert.equal(values.at(-1), 0);
    wheel(-10);
    assert.ok(Math.abs(values.at(-1) - 0.005) < 1e-8);
    assert.equal(outerScrolls, 0);
    const before = values.length;
    assert.equal(wheel(-100, { ctrlKey: true }).defaultPrevented, false);
    wheel(0);
    assert.equal(values.length, before);
    await act(() => env.root.render(React.createElement(VolumeControl, { volume: 0.5, onVolume: v => values.push(v) })));
    wheel(3, { deltaMode: 1 });
    assert.equal(values.at(-1), 0.45, "external volume updates and line-mode mouse wheels are respected");
  } finally { await env.close(); }
});

async function volumeTouchFixture() {
  const env=setup(),values=[];
  function Fixture(){const [volume,setVolume]=React.useState(.5);return React.createElement(React.StrictMode,null,
    React.createElement(VolumeControl,{volume,onVolume:value=>{values.push(value);setVolume(value);}}));}
  await act(()=>env.root.render(React.createElement(Fixture)));
  const label=document.querySelector('.zune-volume'),text=label.querySelector('span'),input=label.querySelector('input');
  const captures=new Set();
  label.setPointerCapture=id=>captures.add(id);label.hasPointerCapture=id=>captures.has(id);label.releasePointerCapture=id=>captures.delete(id);
  async function pointer(type,x=50,y=50,extra={}) {
    const event=new window.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y});
    Object.defineProperties(event,{pointerId:{value:extra.id??1},pointerType:{value:extra.pointerType??'touch'},isPrimary:{value:extra.primary??true}});
    await act(()=> (extra.target??text).dispatchEvent(event));
    return event;
  }
  return {...env,values,label,text,input,captures,pointer};
}

test('touch volume opens the existing slider without changing its value and closes outside or on Escape',async()=>{
  const f=await volumeTouchFixture();
  try {
    await f.pointer('pointerdown');await f.pointer('pointerup');
    assert.equal(document.activeElement,f.input);assert.deepEqual(f.values,[]);assert.equal(f.captures.size,0);
    const click=new window.MouseEvent('click',{bubbles:true,cancelable:true,detail:1});f.text.dispatchEvent(click);
    assert.equal(click.defaultPrevented,true,'label activation cannot jump the range to the tap coordinate');
    await act(()=>f.input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
    assert.notEqual(document.activeElement,f.input);
    await f.pointer('pointerdown');await f.pointer('pointerup');
    await act(()=>document.body.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true})));
    assert.notEqual(document.activeElement,f.input);
    assert.equal(document.querySelector('.volume-popover'),null);assert.equal(document.querySelectorAll('.zune-volume').length,1);
  }finally{await f.close();}
});

test('volume text scrubs in narrow layouts, clamps and cancels safely while mouse and ranges remain native',async()=>{
  const f=await volumeTouchFixture();
  try {
    f.input.style.display='none';
    await f.pointer('pointerdown');await f.pointer('pointermove',90);await f.pointer('pointerup',90);
    assert.equal(f.values.at(-1),.75);assert.equal(f.input.value,'0.75');assert.equal(f.captures.size,0);
    await f.pointer('pointerdown');await f.pointer('pointermove',500);assert.equal(f.values.at(-1),1);
    await f.pointer('pointercancel');const count=f.values.length;await f.pointer('pointermove',10);assert.equal(f.values.length,count);
    await f.pointer('pointerdown');await f.pointer('pointermove',-500);await f.pointer('pointerup',-500);assert.equal(f.values.at(-1),0);
    await f.pointer('pointerdown');await f.pointer('pointermove',50,95);await f.pointer('pointerup',50,95);assert.equal(f.values.at(-1),0);
    await f.pointer('pointerdown');await f.pointer('pointerdown',50,50,{id:2,primary:false});await f.pointer('pointermove',130);await f.pointer('pointerup',130);
    assert.equal(f.values.at(-1),0);
    await f.pointer('pointerdown');window.dispatchEvent(new window.Event('blur'));await f.pointer('pointermove',130);await f.pointer('pointerup',130);assert.equal(f.values.at(-1),0);
    assert.equal(f.captures.size,0);
    const mouse=await f.pointer('pointerdown',50,50,{pointerType:'mouse'});await f.pointer('pointermove',130,50,{pointerType:'mouse'});assert.equal(mouse.defaultPrevented,false);assert.equal(f.values.at(-1),0);
    f.input.style.display='';
    const range=await f.pointer('pointerdown',50,50,{target:f.input});assert.equal(range.defaultPrevented,false);assert.equal(f.captures.size,0);
  }finally{await f.close();}
});

async function fullscreenFixture(invoke) {
  const env = setup();
  let state;
  window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" } }, invoke };
  function Fixture() { state = useNowPlayingFullscreen(); return null; }
  await act(() => env.root.render(React.createElement(React.StrictMode, null, React.createElement(Fixture))));
  return { ...env, state: () => state };
}

test("fullscreen enters, Escape exits first, and leaving the surface restores the window", async () => {
  const mutations = [];
  const env = await fullscreenFixture(async (command, args) => {
    if (command.endsWith("is_fullscreen")) return false;
    mutations.push(args.value);
  });
  let bubbled = false;
  window.addEventListener("keydown", () => { bubbled = true; });
  try {
    await act(() => env.state().toggle());
    assert.equal(env.state().active, true);
    const escape = new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    await act(() => window.dispatchEvent(escape));
    assert.equal(env.state().active, false);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(bubbled, false, "Escape must not also close lyrics or dialogs");
    await act(() => env.state().toggle());
  } finally { await env.close(); }
  assert.deepEqual(mutations, [true, false, true, false]);
});

test("Escape during pending fullscreen entry is serialized after entry", async () => {
  const mutations = [];
  let finishEntry;
  const env = await fullscreenFixture(async (command, args) => {
    if (command.endsWith("is_fullscreen")) return false;
    mutations.push(args.value);
    if (args.value) await new Promise(resolve => { finishEntry = resolve; });
  });
  try {
    await act(() => env.state().toggle());
    assert.equal(env.state().pending, true);
    await act(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" })));
    await act(async () => { finishEntry(); });
    assert.deepEqual(mutations, [true, false]);
    assert.equal(env.state().active, false);
    assert.equal(env.state().pending, false);
  } finally { await env.close(); }
});

test("failed fullscreen requests stay retryable and do not claim fullscreen", async () => {
  let fail = true;
  const env = await fullscreenFixture(async command => {
    if (command.endsWith("is_fullscreen")) return false;
    if (fail) throw new Error("denied");
  });
  try {
    await act(() => env.state().toggle());
    assert.equal(env.state().active, false);
    assert.equal(env.state().pending, false);
    assert.ok(env.state().error);
    fail = false;
    await act(() => env.state().toggle());
    assert.equal(env.state().active, true);
    assert.equal(env.state().error, null);
  } finally { await env.close(); }
});

test("unmount during pending entry still restores the native window", async () => {
  const mutations = [];
  let finishEntry;
  const env = await fullscreenFixture(async (command, args) => {
    if (command.endsWith("is_fullscreen")) return false;
    mutations.push(args.value);
    if (args.value) await new Promise(resolve => { finishEntry = resolve; });
  });
  await act(() => env.state().toggle());
  await env.close();
  await act(async () => { finishEntry(); });
  assert.deepEqual(mutations, [true, false]);
});
