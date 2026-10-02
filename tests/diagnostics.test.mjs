import assert from "node:assert/strict";
import test from "node:test";
import { recordDiagnostic, exportDiagnostics } from "../.tmp/visualizer-tests/utils/diagnostics.js";

test("diagnostics retain bounded structured events and tolerate unavailable storage", () => {
  let stored = null;
  globalThis.localStorage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  for (let attempt = 0; attempt < 205; attempt++) {
    recordDiagnostic({ domain: "music", event: "play_result", outcome: "ok", attempt,
      elapsedMs: 12.8, rawError: "private path", url: "private URL" });
  }
  const { events } = JSON.parse(exportDiagnostics());
  assert.equal(events.length, 200);
  assert.equal(events[0].attempt, 5);
  assert.equal(events[199].elapsedMs, 13);
  assert.ok(!exportDiagnostics().includes("private"));
  const report = JSON.parse(exportDiagnostics());
  assert.match(report.environment.appVersion, /^\d+\.\d+\.\d+$/);
  assert.ok(report.environment.buildId);
  stored = JSON.stringify([{at: new Date().toISOString(),domain:"music",event:"play_result",rawError:"private"},
    {at: new Date().toISOString(),domain:"music",event:"D:/private/music"}]);
  assert.equal(JSON.parse(exportDiagnostics()).events.length, 1);
  assert.ok(!exportDiagnostics().includes("private"));
  globalThis.localStorage = { getItem: () => { throw Error("unavailable"); }, setItem: () => { throw Error("quota"); } };
  assert.doesNotThrow(() => recordDiagnostic({ domain: "library", event: "save", outcome: "error" }));
  assert.deepEqual(JSON.parse(exportDiagnostics()).events, []);
  delete globalThis.localStorage;
});
