import assert from "node:assert/strict";
import test from "node:test";
import { createTileScheduler } from "../.tmp/visualizer-tests/motion/tileScheduler.js";
import { TILE_MOTION } from "../.tmp/visualizer-tests/motion/tokens.js";

function clock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; },
    clearTimeout: key => timers.delete(key),
    timers,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
  };
}

test("simultaneous updates serialize their full cycle and leave a quiet interval", () => {
  const time = clock(), schedule = createTileScheduler(time);
  const starts = [], completions = [];
  for (let i = 0; i < 12; i++) schedule(20_000, done => { starts.push(i); completions.push(done); });
  assert.equal(time.timers.size, 1);
  time.advance(20_000);
  assert.deepEqual(starts, [0]);
  time.advance(60_000);
  assert.deepEqual(starts, [0], "pending work cannot interrupt a dwell");
  completions[0]();
  completions[0]();
  time.advance(TILE_MOTION.ambientGap - 1);
  assert.equal(starts.length, 1);
  time.advance(1);
  assert.deepEqual(starts, [0, 1]);
});

test("cancelling pending or running work releases the queue and leaves no orphan timers", () => {
  const time = clock(), schedule = createTileScheduler(time);
  let started = 0, staleDone;
  const cancelFirst = schedule(10, done => { started++; staleDone = done; });
  const cancelPending = schedule(10, () => assert.fail("cancelled update ran"));
  const cancelLast = schedule(10, () => started++);
  cancelPending();
  time.advance(10);
  cancelFirst();
  time.advance(TILE_MOTION.ambientGap);
  assert.equal(started, 2);
  staleDone();
  cancelLast();
  assert.equal(time.timers.size, 0);
});
