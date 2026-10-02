import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

await build({ entryPoints: ["src/hooks/useMusicLibrary.ts"], outfile: ".tmp/library-scan-recovery/hook.js", bundle: true,
  packages: "external", format: "esm", platform: "browser", logLevel: "silent", define: { "import.meta.env.DEV": "false" }, plugins: [{ name: "native-stubs", setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/(core|event)$/ }, args => ({ path: args.path, namespace: "native" }));
    builder.onLoad({ filter: /.*/, namespace: "native" }, () => ({ contents: "export class Channel {} export const invoke = async (command) => command === 'music_scan_library' ? globalThis.scanFixture() : null; export const listen = async () => () => {};", loader: "js" }));
  } }] });
const { useMusicLibrary } = await import("../.tmp/library-scan-recovery/hook.js");

test("failed scans preserve the active library and returning tracks retain prior statistics", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  let state;
  let queue = ["one"];
  const track = { id: "one", title: "曲目", artist: "歌手", album: "专辑", album_artist: "歌手", genres: [],
    path: "music/one.mp3", file_name: "one.mp3", extension: "mp3", cover_path: null, added_at: 1 };
  const folder = { path: "music", name: "音乐" };
  const activity = { addedAt: 1, playCount: 7, completedCount: 5, skipCount: 0 };
  function Fixture() { state = useMusicLibrary({ setQueue: update => { queue = update(queue); } }); return null; }
  const root = createRoot(document.getElementById("root"));
  try {
    await act(() => root.render(React.createElement(Fixture)));
    await act(() => { state.setFolders([folder]); state.setTracks([track]); state.setTrackActivity({ one: activity }); state.setRestored(true); });
    globalThis.scanFixture = () => { throw Error("音乐文件夹暂不可用，已保留原资料库"); };
    await act(() => state.rescan());
    assert.deepEqual(state.tracks, [track]);
    assert.deepEqual(queue, ["one"]);
    assert.equal(state.trackActivity.one.playCount, 7);
    assert.match(state.scanNote, /已保留资料库/);
    globalThis.scanFixture = () => ({ tracks: [], folders: ["music"], skipped: 0, libraryRevision: 2 });
    await act(() => state.rescan());
    assert.deepEqual(state.tracks, []);
    assert.deepEqual(queue, []);
    assert.equal(state.trackActivity.one.playCount, 7);
    globalThis.scanFixture = () => ({ tracks: [track], folders: ["music"], skipped: 0, libraryRevision: 3 });
    await act(() => state.rescan());
    assert.equal(state.trackActivity.one.playCount, 7);
    assert.equal(state.trackActivity.one.completedCount, 5);
  } finally {
    await act(() => root.unmount()); dom.window.close();
    for (const key of ["window", "document", "scanFixture", "IS_REACT_ACT_ENVIRONMENT"]) delete globalThis[key];
  }
});
