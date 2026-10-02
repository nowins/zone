import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { isLyricsRemoteCacheFresh, LYRICS_NEGATIVE_CACHE_TTL_MS, LYRICS_POSITIVE_CACHE_TTL_MS } from "../.tmp/visualizer-tests/utils/lyricsCache.js";

await build({ entryPoints: ["src/hooks/useLyrics.ts"], outfile: ".tmp/lyrics-cache-recovery/hook.js", bundle: true,
  packages: "external", format: "esm", platform: "browser", logLevel: "silent", define: { "import.meta.env.DEV": "false" }, plugins: [{ name: "lyrics-stubs", setup(builder) {
    builder.onResolve({ filter: /\/lyrics\/providers$/ }, () => ({ path: "providers", namespace: "fixture" }));
    builder.onResolve({ filter: /useLyricsProviderSettings$/ }, () => ({ path: "settings", namespace: "fixture" }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "native", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "js", contents: args.path === "providers"
      ? "export const searchLyricsProviders = async () => globalThis.lyricsFixture.search(); export const getLyricsCandidateSource = async candidate => globalThis.lyricsFixture.source(candidate);"
      : args.path === "settings" ? "export const useLyricsProviderSettings = () => ({configs:[{id:'qq',enabled:true,priority:10,timeoutMs:8000}]});"
      : "export const invoke = async () => null;" }));
  } }] });
const { useLyrics } = await import("../.tmp/lyrics-cache-recovery/hook.js");
const track = { id: "one", title: "曲目", artist: "歌手", album: "专辑", path: "one.mp3", duration_seconds: 120 };
const candidate = { id: "qq:one", providerId: "qq", providerName: "QQ", title: "曲目", artist: "歌手", score: { total: 100 } };

test("remote cache expires genuine misses and rejects invalid clocks", () => {
  const now = 1000000000;
  assert.equal(isLyricsRemoteCacheFresh({ updatedAt: now - LYRICS_NEGATIVE_CACHE_TTL_MS }, now), false);
  assert.equal(isLyricsRemoteCacheFresh({ updatedAt: now - LYRICS_NEGATIVE_CACHE_TTL_MS + 1 }, now), true);
  assert.equal(isLyricsRemoteCacheFresh({ updatedAt: now - LYRICS_POSITIVE_CACHE_TTL_MS, autoSourceId: "source" }, now), false);
  assert.equal(isLyricsRemoteCacheFresh({ updatedAt: now + 1 }, now), false);
  assert.equal(isLyricsRemoteCacheFresh({ updatedAt: NaN }, now), false);
});

test("real lyrics hook retries expired misses, provider errors and broken cached candidates", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zone.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  let root, state, searches = 0;
  globalThis.lyricsFixture = { search: () => { searches++; return { candidates: [], errors: [], outcomes: [] }; }, source: () => { throw Error("来源暂不可用"); } };
  function Fixture() { state = useLyrics(track, 120); return null; }
  async function mount() { root = createRoot(document.getElementById("root")); await act(async () => { root.render(React.createElement(Fixture)); }); }
  async function unmount() { await act(() => root.unmount()); }
  try {
    await mount(); assert.equal(searches, 1); assert.equal(state.status, "missing"); await unmount();
    await mount(); assert.equal(searches, 1); await unmount();
    let saved = JSON.parse(localStorage.getItem("zone-local-lyrics-v1"));
    saved.remoteCache.one.updatedAt = Date.now() - LYRICS_NEGATIVE_CACHE_TTL_MS;
    localStorage.setItem("zone-local-lyrics-v1", JSON.stringify(saved));
    await mount(); assert.equal(searches, 2); await unmount();
    localStorage.clear();
    globalThis.lyricsFixture.search = () => { searches++; return { candidates: [], errors: [{ providerName: "QQ", message: "服务暂不可用" }], outcomes: [] }; };
    await mount(); assert.equal(state.status, "error"); assert.equal(localStorage.getItem("zone-local-lyrics-v1"), null); await unmount();
    await mount(); assert.equal(searches, 4); await unmount();
    saved.remoteCache.one = { ...saved.remoteCache.one, updatedAt: Date.now(), autoSourceId: "provider:qq:one", candidates: [candidate] };
    localStorage.setItem("zone-local-lyrics-v1", JSON.stringify(saved));
    globalThis.lyricsFixture.search = () => { searches++; return { candidates: [candidate], errors: [], outcomes: [] }; };
    await mount(); assert.equal(searches, 5); assert.equal(state.status, "error");
    assert.equal(JSON.parse(localStorage.getItem("zone-local-lyrics-v1")).remoteCache.one.updatedAt, saved.remoteCache.one.updatedAt);
    await unmount();
  } finally {
    dom.window.close();
    for (const key of ["window", "document", "localStorage", "lyricsFixture", "IS_REACT_ACT_ENVIRONMENT"]) delete globalThis[key];
  }
});
