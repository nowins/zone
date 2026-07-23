import assert from "node:assert/strict";
import test from "node:test";
import {
  runLyricsProviderSearchTasks,
} from "../.tmp/visualizer-tests/utils/lyricsProviderSearch.js";

function task(providerId, run) {
  return { providerId, providerName: providerId.toUpperCase(), run };
}

test("priority fallback stops after the first high-confidence provider result", async () => {
  const calls = [];
  const result = await runLyricsProviderSearchTasks([
    task("first", async () => {
      calls.push("first");
      return [{ id: "weak", strong: false }];
    }),
    task("second", async () => {
      calls.push("second");
      return [{ id: "strong", strong: true }];
    }),
    task("third", async () => {
      calls.push("third");
      return [{ id: "unused", strong: true }];
    }),
  ], "priority-fallback", new AbortController().signal, (items) => items.some((item) => item.strong));

  assert.deepEqual(calls, ["first", "second"]);
  assert.deepEqual(result.candidates.map((item) => item.id), ["weak", "strong"]);
  assert.deepEqual(result.outcomes.map((item) => [item.providerId, item.status]), [
    ["first", "ready"],
    ["second", "ready"],
  ]);
});

test("all-provider search starts every provider together and combines their candidates", async () => {
  const started = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = runLyricsProviderSearchTasks([
    task("first", async () => {
      started.push("first");
      await gate;
      return ["first-result"];
    }),
    task("second", async () => {
      started.push("second");
      await gate;
      return ["second-result"];
    }),
    task("third", async () => {
      started.push("third");
      await gate;
      return ["third-result"];
    }),
  ], "all", new AbortController().signal, () => true);

  await Promise.resolve();
  assert.deepEqual(started, ["first", "second", "third"]);
  release();
  const result = await pending;
  assert.deepEqual(result.candidates, ["first-result", "second-result", "third-result"]);
  assert.deepEqual(result.outcomes.map((item) => item.providerId), ["first", "second", "third"]);
});

test("all-provider search isolates one provider failure", async () => {
  const result = await runLyricsProviderSearchTasks([
    task("working", async () => ["candidate"]),
    task("broken", async () => {
      throw new Error("timeout");
    }),
  ], "all", new AbortController().signal, () => true);

  assert.deepEqual(result.candidates, ["candidate"]);
  assert.deepEqual(result.errors, [{
    providerId: "broken",
    providerName: "BROKEN",
    message: "timeout",
  }]);
  assert.deepEqual(result.outcomes.map((item) => [item.providerId, item.status]), [
    ["working", "ready"],
    ["broken", "error"],
  ]);
});

test("all-provider search distinguishes empty results from failures", async () => {
  const result = await runLyricsProviderSearchTasks([
    task("empty", async () => []),
  ], "all", new AbortController().signal, () => true);

  assert.deepEqual(result.outcomes, [{
    providerId: "empty",
    providerName: "EMPTY",
    status: "empty",
    candidateCount: 0,
  }]);
});
