import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

await build({ entryPoints: ["src/components/AppErrorBoundary.tsx"], outfile: ".tmp/error-recovery/boundary.js", bundle: true,
  packages: "external", format: "esm", platform: "browser", logLevel: "silent", define: { "import.meta.env.DEV": "false" }, plugins: [{ name: "native", setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "core", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const invoke = async (command,args) => {globalThis.exportedReport = args.content; return true;};", loader: "js" }));
  } }] });
const { AppErrorBoundary } = await import("../.tmp/error-recovery/boundary.js");

test("fatal UI keeps private errors out of the screen and offers diagnostic recovery", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zone.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("root"));
  const originalError = console.error; console.error = () => {};
  function Broken() { throw Error("D:/private/music.mp3"); }
  try {
    await act(() => root.render(React.createElement(AppErrorBoundary, null, React.createElement(Broken))));
    assert.match(document.body.textContent, /重新加载/); assert.ok(!document.body.textContent.includes("private"));
    const exportButton = [...document.querySelectorAll("button")].find(button => button.textContent === "导出诊断记录");
    await act(() => exportButton.click());
    assert.match(document.body.textContent, /诊断记录已导出/); assert.ok(!globalThis.exportedReport.includes("private"));
    assert.equal(JSON.parse(globalThis.exportedReport).events.at(-1).event, "ui_fatal_error");
  } finally {
    console.error = originalError; await act(() => root.unmount()); dom.window.close();
    for (const key of ["window", "document", "localStorage", "exportedReport", "IS_REACT_ACT_ENVIRONMENT"]) delete globalThis[key];
  }
});
