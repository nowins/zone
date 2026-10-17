import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const runtimePath = `.tmp/device-recovery-${process.pid}/runtime.mjs`;
await build({ entryPoints: ["src/hooks/usePodcastRecovery.ts"], outfile: runtimePath,
  bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { usePodcastRecovery } = await import(new URL(`../${runtimePath}`, import.meta.url));
const output = (id, groupId = id) => ({ kind: "audiooutput", deviceId: id, groupId });
const input = id => ({ kind: "audioinput", deviceId: id, groupId: id });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

async function fixture() {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  let list = [output("default", "headphones"), output("headphones"), output("speakers")];
  let intent = true, pauses = 0, resumes = 0, expired = false, generation = 1;
  const pending = [];
  let deferredReads = false;
  const devices = new window.EventTarget();
  devices.enumerateDevices = () => {
    if (!deferredReads) return Promise.resolve(list);
    const read = deferred();pending.push(read);return read.promise;
  };
  Object.defineProperty(window.navigator, "mediaDevices", { value: devices });
  const audio = new window.EventTarget();Object.assign(audio, { paused: false, currentTime: 42, error: null });
  const options = { audioRef: { current: audio }, episodeId: "episode", remote: true,
    hasIntent: () => intent, expireSleep: () => expired, retry() {}, generation: () => generation,
    resumeGraph: () => { resumes++; }, pauseForDevice: () => { pauses++;intent = false; } };
  function Harness() { usePodcastRecovery(options);return null; }
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Harness))));
  return { audio, devices, pending, get pauses() { return pauses; }, get resumes() { return resumes; },
    set list(value) { list = value; }, set deferred(value) { deferredReads = value; },
    set intent(value) { intent = value; }, set expired(value) { expired = value; },
    nextIntent() { generation++;intent = true; },
    changed: async () => act(async () => devices.dispatchEvent(new window.Event("devicechange"))),
    returned: async () => act(async () => window.dispatchEvent(new window.Event("focus"))),
    resolve: async (index, value) => act(async () => pending[index].resolve(value)),
    close: async () => { await act(async () => root.unmount());dom.window.close(); },
  };
}

test("default output group remapping pauses even when the output device IDs stay the same", async () => {
  const h = await fixture();
  try {
    h.list = [output("default", "speakers"), output("headphones"), output("speakers")];
    await h.changed();assert.equal(h.pauses, 1);
  } finally { await h.close(); }
});

test("an older enumeration cannot replace the latest output baseline and pause a later explicit resume", async () => {
  const h = await fixture();
  try {
    h.deferred = true;
    await h.changed();await h.changed();
    await h.resolve(1, [output("new-output")]);assert.equal(h.pauses, 1);
    await h.resolve(0, [output("default", "headphones"), output("headphones"), output("speakers")]);
    h.intent = true;
    await h.changed();await h.resolve(2, [output("new-output"), input("new-microphone")]);
    assert.equal(h.pauses, 1, "input-only change after resuming must keep playback intent");
  } finally { await h.close(); }
});

test("input-only changes, reordering and results after cleanup do not pause playback", async () => {
  const h = await fixture();let closed = false;
  try {
    h.list = [input("microphone"), output("speakers"), output("headphones"), output("default", "headphones")];
    await h.changed();assert.equal(h.pauses, 0);
    h.deferred = true;await h.changed();await h.close();closed = true;
    h.pending[0].resolve([output("removed")]);await Promise.resolve();
    assert.equal(h.pauses, 0);
  } finally { if (!closed) await h.close(); }
});

test("empty groups, permission exposure and ambiguous physical groups do not invent a default route change", async () => {
  const h = await fixture();
  try {
    h.list = [output("default", ""), output("headphones", ""), output("speakers", "")];
    await h.changed();assert.equal(h.pauses, 0);
    h.list = [output("default", "exposed"), output("headphones", "exposed"), output("speakers", "other")];
    await h.changed();assert.equal(h.pauses, 0, "first exposed mapping establishes a baseline");
    h.list = [output("default", "new-salt"), output("headphones", "new-salt"), output("speakers", "other-salt")];
    await h.changed();assert.equal(h.pauses, 0, "group IDs alone are not output endpoint IDs");
    h.list = [output("default", "shared"), output("headphones", "shared"), output("speakers", "shared")];
    await h.changed();assert.equal(h.pauses, 0, "multiple outputs on one physical group are ambiguous");
    h.devices.enumerateDevices = async () => { throw new Error("permission denied"); };
    await h.changed();assert.equal(h.pauses, 0);
  } finally { await h.close(); }
});

test("returning while paused, without play intent or after sleep expiry never resumes the graph", async () => {
  const h = await fixture();
  try {
    h.audio.paused = true;await h.returned();assert.equal(h.resumes, 0);
    h.audio.paused = false;h.intent = false;await h.returned();assert.equal(h.resumes, 0);
    h.intent = true;h.expired = true;await h.returned();assert.equal(h.resumes, 0);
    h.expired = false;await h.returned();assert.equal(h.resumes, 1);
  } finally { await h.close(); }
});

test("an enumeration from an older play attempt cannot pause a later explicit continuation", async () => {
  const h = await fixture();
  try {
    h.deferred = true;await h.changed();h.nextIntent();
    await h.resolve(0, [output("confirmed-output")]);assert.equal(h.pauses, 0);
    await h.changed();await h.resolve(1, [output("confirmed-output"), input("microphone")]);
    assert.equal(h.pauses, 0, "the latest observed output still becomes the baseline");
  } finally { await h.close(); }
});
