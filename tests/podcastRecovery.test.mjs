import assert from "node:assert/strict";
import test from "node:test";
import { createPodcastRecovery } from "../.tmp/visualizer-tests/utils/podcastRecovery.js";
function fixture() {
  let intent = true, online = true, expired = false, generation = 0, retries = 0, resumes = 0;
  const timers = new Map(); let next = 0;
  const audio = { currentTime: 42, paused: true, error: null };
  const controller = createPodcastRecovery({ audio, hasIntent: () => intent, online: () => online, expireSleep: () => expired,
    isRemote: () => true, retry: () => { retries++; }, resumeGraph: () => { resumes++; }, generation: () => generation,
    setTimer: (callback, ms) => { const id = ++next; timers.set(id, { callback, ms }); return id; }, clearTimer: id => timers.delete(id) });
  return { controller, audio, timers, get retries() { return retries; }, get resumes() { return resumes; },
    pause() { intent = false; generation++; }, play() { intent = true; generation++; },
    set online(value) { online = value; }, set expired(value) { expired = value; },
    tick() { const first = timers.entries().next().value; if (first) { timers.delete(first[0]); first[1].callback(); } } };
}
test("reconnect is finite and resets only after the real media clock advances", () => {
  const h = fixture();
  for (let index = 0; index < 5; index++) { h.controller.stalled(true); h.tick(); }
  assert.equal(h.retries, 3); assert.equal(h.timers.size, 0);
  h.audio.paused = false; h.audio.currentTime += 3; h.controller.healthy();
  h.controller.stalled(true); h.tick(); assert.equal(h.retries, 4);
});
test("offline recovery preserves intent but a later pause, resume, sleep or dispose cancels old work", () => {
  const h = fixture(); h.online = false; h.controller.offline(); h.controller.stalled(true);
  assert.equal(h.timers.size, 0); h.online = true; h.controller.returned(); assert.equal(h.timers.size, 1);
  h.pause(); h.play(); h.tick(); assert.equal(h.retries, 0);
  h.controller.stalled(true); h.expired = true; h.tick(); assert.equal(h.retries, 0);
  h.expired = false; h.controller.stalled(true); h.controller.dispose(); h.tick(); assert.equal(h.retries, 0);
});
test("decode errors do not retry and focus only resumes an audio graph with active intent", () => {
  const h = fixture(); h.audio.error = { code: 3 }; h.controller.stalled(true); h.tick(); assert.equal(h.retries, 0);
  h.audio.paused = false; h.controller.returned(); assert.equal(h.resumes, 1);
  h.pause(); h.controller.returned(); assert.equal(h.resumes, 1);
});

test("focus and online return cannot rearm a stall from an older play generation", () => {
  for (const offline of [false, true]) {
    const h = fixture();
    if (offline) { h.online = false;h.controller.offline(); }
    else h.controller.stalled();
    h.pause();h.play();h.online = true;h.audio.paused = false;
    h.controller.returned();
    assert.equal(h.resumes, 1, "the current playing graph may still recover");
    assert.equal(h.timers.size, 0, "old waiting state must not inherit the new generation");
    h.tick();assert.equal(h.retries, 0);
    h.controller.stalled(true);h.tick();assert.equal(h.retries, 1, "a new stall still retries");
    h.controller.dispose();
  }
});

test("a new stall replaces the old generation timer before it fires", () => {
  const h = fixture();h.controller.stalled();h.pause();h.play();
  h.controller.stalled(true);
  assert.deepEqual([...h.timers.values()].map(timer => timer.ms), [1000]);
  h.tick();assert.equal(h.retries, 1);
  h.controller.dispose();
});
