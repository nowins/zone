import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { isDocumentVisible } from '../.tmp/visualizer-tests/utils/visualizerBus.js';

await build({ entryPoints: ['src/hooks/useNativeWindowVisibility.ts'], outfile: '.tmp/native-visibility/hook.js', bundle: true, packages: 'external', format: 'esm', platform: 'browser', logLevel: 'silent', plugins: [{ name: 'native', setup(builder) {
  builder.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'core',namespace:'fixture'}));
  builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const isTauri=()=>true; export const invoke=()=>globalThis.__nativeWindowQuery();',loader:'js'}));
} }] });
const { useNativeWindowVisibility } = await import('../.tmp/native-visibility/hook.js');
test('native visibility stops visible WebView activity, avoids overlapping queries and cleans late results', async () => {
  const dom = new JSDOM('<div id="root"></div>', {pretendToBeVisual:true});
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
  const intervals=new Map();let sequence=0,events=0;
  window.setInterval=callback=>{intervals.set(++sequence,callback);return sequence;};window.clearInterval=id=>intervals.delete(id);
  document.addEventListener('zone-window-visibility',()=>events++);
  globalThis.__nativeWindowQuery=()=>Promise.resolve(true);
  function Fixture(){useNativeWindowVisibility();return null;}
  const root=createRoot(document.getElementById('root'));
  const tick=async()=>act(async()=>{[...intervals.values()].forEach(callback=>callback());await Promise.resolve();});
  try {
    await act(()=>root.render(React.createElement(React.StrictMode,null,React.createElement(Fixture))));
    assert.equal(intervals.size,1);assert.equal(isDocumentVisible(),true);
    globalThis.__nativeWindowQuery=()=>Promise.resolve(false);await tick();
    assert.equal(document.visibilityState,'visible');assert.equal(isDocumentVisible(),false);
    const previous=events;await tick();assert.equal(events,previous,'unchanged visibility does not trigger rendering');
    let finish,calls=0;globalThis.__nativeWindowQuery=()=>{calls++;return new Promise(resolve=>finish=resolve);};
    await tick();await tick();assert.equal(calls,1,'in-flight native reads are not duplicated');
    await act(()=>root.unmount());assert.equal(intervals.size,0);
    finish(true);await Promise.resolve();assert.equal(events,previous);assert.equal(document.documentElement.dataset.zoneWindowVisible,undefined);
  } finally {
    dom.window.close();for(const key of ['window','document','IS_REACT_ACT_ENVIRONMENT','__nativeWindowQuery'])delete globalThis[key];
  }
});
