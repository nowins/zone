import assert from "node:assert/strict";
import test from "node:test";
import React,{act} from "react";
import {JSDOM} from "jsdom";
import {build} from "esbuild";
await build({stdin:{contents:'import React from "react"; import {usePodcastBrowsePosition} from "./src/views/podcast/components/BrowsePosition"; export function View(){const ref=usePodcastBrowsePosition("focus-regression");return <main ref={ref}><input aria-label="筛选"/><article data-podcast-episode="episode"><button className="podcast-episode-open">单集</button></article></main>}',resolveDir:process.cwd(),loader:"tsx"},outfile:".tmp/browse-position-tests/view.mjs",bundle:true,packages:"external",format:"esm",platform:"browser",logLevel:"silent"});
const {View}=await import("../.tmp/browse-position-tests/view.mjs");
test("explicit filter focus ends a pending browse restoration before menu DOM changes",async()=>{
  const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true});
  for(const key of ["window","document","Element","HTMLElement","MutationObserver"])globalThis[key]=dom.window[key];globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  const {createRoot}=await import("react-dom/client");let root=createRoot(document.getElementById("root"));
  await act(async()=>root.render(React.createElement(View)));document.querySelector('button').focus();document.querySelector('main').scrollTop=400;
  await act(async()=>root.unmount());root=createRoot(document.getElementById("root"));
  await act(async()=>root.render(React.createElement(View)));assert.equal(document.activeElement,document.querySelector('button'));
  const filter=document.querySelector('input');filter.focus();
  await act(async()=>{const menu=document.createElement('div');menu.setAttribute('role','listbox');document.querySelector('main').append(menu);await Promise.resolve();});
  assert.equal(document.activeElement,filter,"asynchronous menu/list updates must not steal focus back to the episode");
  await act(async()=>root.unmount());dom.window.close();
});
