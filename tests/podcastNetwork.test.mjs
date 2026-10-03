import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const output = path.resolve(".tmp/podcast-network-api-tests.mjs");
await mkdir(path.dirname(output), { recursive: true });
await build({ entryPoints: ["src/views/podcast/api.ts"], outfile: output, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "native-network", setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "native", namespace: "mock" }));
    builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export const invoke=(name,args)=>globalThis.podcastNetworkMock(name,args);" }));
  } }] });
const api = await import(pathToFileURL(output));

test("superseding and unmounting search cancel native IDs without losing the newer request", async () => {
  const calls = []; const resolvers = [];
  globalThis.podcastNetworkMock = (name, args) => {
    calls.push({ name, args });
    return name === "podcast_cancel_network_request" ? Promise.resolve() : new Promise(resolve => resolvers.push(resolve));
  };
  const first = api.searchApplePodcasts("old", 10);
  const oldId = calls[0].args.requestId;
  const second = api.searchApplePodcasts("new", 10);
  assert.equal(calls[1].name, "podcast_cancel_network_request");
  assert.equal(calls[1].args.requestId, oldId);
  const newId = calls[2].args.requestId; assert.notEqual(newId, oldId);
  resolvers[0]([]); await first;
  api.cancelPodcastViewRequests();
  assert.equal(calls.at(-1).args.requestId, newId);
  resolvers[1]([]); await second;
});

test("background download remains cancellable after the view remounts and clears only when native completion settles", async () => {
  const calls = []; let complete;
  globalThis.podcastNetworkMock = (name, args) => {
    calls.push({ name, args });
    return name === "podcast_cancel_network_request" ? Promise.resolve() : new Promise(resolve => { complete = resolve; });
  };
  const id = "a".repeat(64); const changes = [];
  const unsubscribe = api.subscribePodcastDownloads(() => changes.push(api.getActivePodcastDownloadId()));
  const pending = api.downloadPodcastEpisode(id);
  assert.equal(api.downloadPodcastEpisode(id), pending);
  assert.equal(calls.length, 1, "duplicate episodes reuse the native download rather than cancel it");
  assert.equal(api.getActivePodcastDownloadId(), id);
  api.cancelPodcastViewRequests(); assert.equal(calls.length, 1);
  api.cancelPodcastRequest("download-" + id);
  assert.equal(calls[1].name, "podcast_cancel_network_request");
  assert.equal(api.getActivePodcastDownloadId(), id);
  complete({ resumed: true }); await pending;
  assert.equal(api.getActivePodcastDownloadId(), null);
  assert.deepEqual(changes, [id, null]); unsubscribe();
});
