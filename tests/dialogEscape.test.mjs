import assert from "node:assert/strict";
import test from "node:test";
import {build} from "esbuild";
import {JSDOM} from "jsdom";
import React,{act} from "react";
import {createRoot} from "react-dom/client";
const output=`.tmp/dialog-escape-${process.pid}.mjs`;
await build({stdin:{contents:'export { Dialog } from "./src/components/Dialog";',resolveDir:process.cwd(),loader:"ts"},outfile:output,bundle:true,packages:"external",format:"esm",platform:"browser",logLevel:"silent"});
const {Dialog}=await import(new URL(`../${output}`,import.meta.url));
test("Escape belongs to the top dialog, including while busy, and preserves the underlying page",async()=>{
 const dom=new JSDOM('<div id="root"></div>');Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,getComputedStyle:dom.window.getComputedStyle,IS_REACT_ACT_ENVIRONMENT:true});
 let pageEscapes=0,cancelled=0;window.addEventListener("keydown",()=>pageEscapes++);
 const root=createRoot(document.getElementById("root"));
 const render=busy=>React.createElement(Dialog,{titleId:"dialog-title",title:"设置",kicker:"节目设置",busy,onCancel:()=>cancelled++,onSubmit(){},children:React.createElement("button",null,"取消")});
 try{
  await act(()=>root.render(render(false)));
  await act(()=>document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  assert.equal(cancelled,1);assert.equal(pageEscapes,0);
  await act(()=>root.render(render(true)));
  await act(()=>document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  assert.equal(cancelled,1);assert.equal(pageEscapes,0);
 }finally{await act(()=>root.unmount());dom.window.close();}
});
