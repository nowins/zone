import assert from "node:assert/strict";
import test from "node:test";
import {
  createShuffleOrder,
  haveSameQueueItems,
  insertTracksIntoQueue,
  playbackSourceKey,
  queueAfterCurrent,
  reconcileActiveTrack,
  reconcileQueueWithLibrary,
  resolvePreviousAction,
  resolveQueueMove,
} from "../.tmp/visualizer-tests/utils/playback.js";

test("library metadata refresh keeps the active audio source stable", () => {
  const original = { id: "track-a", path: "D:\\Music\\song.mp3", title: "旧标题" };
  const refreshed = { ...original, title: "新标题" };

  assert.equal(playbackSourceKey(original), playbackSourceKey(refreshed));
  assert.notEqual(
    playbackSourceKey(original),
    playbackSourceKey({ ...refreshed, path: "D:\\Music\\song-renamed.mp3" }),
  );
});

test("shuffle keeps the current track first and includes every queue item", () => {
  const order = createShuffleOrder(["a", "b", "c", "d"], "c", () => 0);

  assert.equal(order[0], "c");
  assert.ok(haveSameQueueItems(order, ["a", "b", "c", "d"]));
  assert.equal(new Set(order).size, 4);

  const duplicateOrder = createShuffleOrder(["a", "b", "a"], "a", () => 0);
  assert.ok(haveSameQueueItems(duplicateOrder, ["a", "b", "a"]));
});

test("normal queue navigation moves in both directions", () => {
  assert.deepEqual(resolveQueueMove(["a", "b", "c"], "b", 1, "off"), { kind: "move", trackId: "c" });
  assert.deepEqual(resolveQueueMove(["a", "b", "c"], "b", -1, "off"), { kind: "move", trackId: "a" });
});

test("repeat off stops at queue boundaries", () => {
  assert.deepEqual(resolveQueueMove(["a", "b"], "b", 1, "off"), { kind: "boundary" });
  assert.deepEqual(resolveQueueMove(["a", "b"], "a", -1, "one"), { kind: "boundary" });
});

test("repeat all wraps and explicitly restarts a one-track queue", () => {
  assert.deepEqual(resolveQueueMove(["a", "b"], "b", 1, "all"), { kind: "move", trackId: "a" });
  assert.deepEqual(resolveQueueMove(["a"], "a", 1, "all"), { kind: "restart", trackId: "a" });
});

test("a stale active id recovers at the nearest queue edge", () => {
  assert.deepEqual(resolveQueueMove(["a", "b"], "missing", 1, "off"), { kind: "move", trackId: "a" });
  assert.deepEqual(resolveQueueMove(["a", "b"], "missing", -1, "off"), { kind: "move", trackId: "b" });
});

test("expanded queue order includes every other track after the current item", () => {
  const queue = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.deepEqual(queueAfterCurrent(queue, "c").map((item) => item.id), ["d", "a", "b"]);
});

test("queue membership comparison detects stale shuffle orders", () => {
  assert.equal(haveSameQueueItems(["a", "b", "c"], ["c", "a", "b"]), true);
  assert.equal(haveSameQueueItems(["a", "b", "c"], ["a", "b", "d"]), false);
});

test("library refresh preserves valid queue entries and falls back when all are gone", () => {
  assert.deepEqual(reconcileQueueWithLibrary(["a", "missing", "b"], ["a", "b", "c"]), ["a", "b"]);
  assert.deepEqual(reconcileQueueWithLibrary(["missing"], ["a", "b"]), ["a", "b"]);
  assert.deepEqual(reconcileQueueWithLibrary([], ["a", "b"]), ["a", "b"]);
});

test("library refresh replaces a stale active track from the preserved queue", () => {
  assert.equal(reconcileActiveTrack("missing", ["b", "a"], ["a", "b", "c"]), "b");
  assert.equal(reconcileActiveTrack("missing", [], []), null);
});


test("queue insert mode can place tracks next or at end", () => {
  assert.deepEqual(
    insertTracksIntoQueue(["a", "b", "c"], "b", ["x", "y"], "play_next"),
    ["a", "b", "x", "y", "c"],
  );
  assert.deepEqual(
    insertTracksIntoQueue(["a", "b", "c"], "b", ["x"], "append_end"),
    ["a", "b", "c", "x"],
  );
  assert.deepEqual(
    insertTracksIntoQueue(["a", "x", "b"], "a", ["x", "y"], "play_next"),
    ["a", "x", "y", "b"],
  );
});

test("adaptive previous restarts after the threshold and otherwise goes back", () => {
  assert.equal(resolvePreviousAction(0.5, true), "previous");
  assert.equal(resolvePreviousAction(3.1, true), "restart");
  assert.equal(resolvePreviousAction(30, false), "previous");
});
