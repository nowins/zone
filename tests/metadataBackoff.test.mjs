import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

await build({ entryPoints: ["src/hooks/useMetadataEnrichment.ts"], outfile: ".tmp/metadata-backoff/hook.js", bundle: true,
  packages: "external", format: "esm", platform: "browser", logLevel: "silent", define: { "import.meta.env.DEV": "false" }, plugins: [{ name: "native", setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "core", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const invoke = async command => globalThis.metadataFixture(command);", loader: "js" }));
  } }] });
const { useMetadataEnrichment } = await import("../.tmp/metadata-backoff/hook.js");

test("automatic metadata backs off a failed provider while local and Apple sources stay available", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zone.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  let api, requests = 0;
  const local = { id: "local", providerId: "local-sidecar", confidence: 90 };
  globalThis.metadataFixture = command => {
    if (command === "metadata_list_providers") return ["local-sidecar", "apple-music-cn", "netease-music"].map(id => ({id,enabled:true,available:true}));
    if (command === "metadata_search_netease_music") { requests++; throw Error("网易云音乐暂不可用，请 5 分钟后重试"); }
    if (command === "metadata_search_sidecars") return [local];
    if (command === "metadata_search_apple_music") return [{id:"apple",confidence:80}];
    return [];
  };
  function Fixture() { api = useMetadataEnrichment({ tracks: [], setTracks: () => {}, restored: false }); return null; }
  const root = createRoot(document.getElementById("root"));
  const payload = {kind:"album",title:"专辑",tracks:[{id:"one",title:"曲目",artist:"歌手",album:"专辑",path:"one.mp3"}]};
  try {
    await act(async () => root.render(React.createElement(Fixture)));
    let result;
    await act(async () => { result = await api.search(payload, undefined, true); });
    assert.deepEqual(result.map(item => item.id), ["local", "apple"]); assert.equal(requests, 1);
    await act(async () => { result = await api.search(payload, undefined, true); });
    assert.deepEqual(result.map(item => item.id), ["local", "apple"]); assert.equal(requests, 1);
  } finally {
    await act(() => root.unmount()); dom.window.close();
    for (const key of ["window", "document", "localStorage", "metadataFixture", "IS_REACT_ACT_ENVIRONMENT"]) delete globalThis[key];
  }
});
