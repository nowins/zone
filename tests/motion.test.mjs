import assert from "node:assert/strict";
import test from "node:test";

import {
  animateValue,
  _setAnimationClockForTesting,
} from "../.tmp/visualizer-tests/motion/animate.js";
import {
  computeFlipDelta,
  registerFlipSource,
  takeFlipSource,
} from "../.tmp/visualizer-tests/motion/flip.js";
import { clamp, easeOutCubic, lerp, smoothstep } from "../.tmp/visualizer-tests/motion/math.js";
import { resolvePageTransition } from "../.tmp/visualizer-tests/motion/pageTransition.js";
import {
  advanceSpring,
  createSpring,
  springSettled,
} from "../.tmp/visualizer-tests/motion/spring.js";
import {
  MOTION_DURATIONS,
  MOTION_DRIFT,
  MOTION_EASINGS,
  MOTION_STAGGER,
  resolveExitDurationMs,
  SPRING_PRESETS,
} from "../.tmp/visualizer-tests/motion/tokens.js";
import { cubicBezier, MOTION_TWEENS } from "../.tmp/visualizer-tests/motion/tween.js";

function createFakeRaf() {
  let now = 0;
  let pending = null;
  return {
    now: () => now,
    raf: (callback) => {
      pending = callback;
    },
    step(ms = 16) {
      now += ms;
      const callback = pending;
      pending = null;
      if (callback) callback(now);
    },
    hasPending: () => pending !== null,
  };
}

test("math: clamp/lerp/smoothstep/easeOutCubic boundaries", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(42, 0, 10), 10);

  assert.equal(lerp(10, 20, 0), 10);
  assert.equal(lerp(10, 20, 1), 20);
  assert.equal(lerp(10, 20, 0.25), 12.5);

  assert.equal(smoothstep(0, 1, -1), 0);
  assert.equal(smoothstep(0, 1, 0), 0);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
  assert.equal(smoothstep(0, 1, 1), 1);
  assert.equal(smoothstep(0, 1, 2), 1);

  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeOutCubic(0.5), 0.875);
});

test("tokens: duration tiers in ascending order", () => {
  assert.deepEqual(
    Object.keys(MOTION_DURATIONS).sort(),
    ["chrome", "content", "cycle", "instant", "loader", "micro", "page", "press"].sort(),
  );
  assert.ok(MOTION_DURATIONS.instant < MOTION_DURATIONS.press);
  assert.ok(MOTION_DURATIONS.press < MOTION_DURATIONS.micro);
  assert.ok(MOTION_DURATIONS.micro < MOTION_DURATIONS.content);
  assert.ok(MOTION_DURATIONS.content < MOTION_DURATIONS.page);
  assert.ok(MOTION_DURATIONS.page < MOTION_DURATIONS.chrome);
  assert.ok(MOTION_DURATIONS.chrome < MOTION_DURATIONS.cycle);
  assert.ok(MOTION_DURATIONS.cycle < MOTION_DURATIONS.loader);

  assert.deepEqual([...MOTION_EASINGS.standard], [0.23, 1, 0.32, 1]);
  assert.ok(MOTION_DRIFT.s < MOTION_DRIFT.m && MOTION_DRIFT.m < MOTION_DRIFT.l);
  assert.ok(MOTION_STAGGER.step > 0 && MOTION_STAGGER.max >= MOTION_STAGGER.step);

  for (const name of ["snappy", "gentle", "bouncy"]) {
    const preset = SPRING_PRESETS[name];
    assert.equal(typeof preset.stiffness, "number");
    assert.equal(typeof preset.damping, "number");
    assert.equal(typeof preset.mass, "number");
  }
});

test("tokens: resolveExitDurationMs syncs JS lifecycles with reduced motion", () => {
  assert.equal(resolveExitDurationMs(160, false), 160);
  assert.equal(resolveExitDurationMs(160, true), MOTION_DURATIONS.instant);
  // Zero-length transitions (same-page navigation) stay zero either way.
  assert.equal(resolveExitDurationMs(0, true), 0);
  assert.equal(resolveExitDurationMs(0, false), 0);
});

test("spring: snappy converges to the target and settles", () => {
  let state = createSpring(0);
  let steps = 0;
  while (!springSettled(state, 100) && steps < 1000) {
    state = advanceSpring(state, SPRING_PRESETS.snappy, 100, 16);
    steps += 1;
  }
  assert.ok(springSettled(state, 100));
  assert.ok(Math.abs(state.value - 100) < 0.001);
  assert.ok(steps < 200, `settled in ${steps} steps`);
});

test("spring: bouncy overshoots before settling", () => {
  let state = createSpring(0);
  let peak = 0;
  for (let i = 0; i < 400 && !springSettled(state, 1); i += 1) {
    state = advanceSpring(state, SPRING_PRESETS.bouncy, 1, 16);
    peak = Math.max(peak, state.value);
  }
  assert.ok(peak > 1.05, `expected visible overshoot, peak=${peak}`);
  assert.ok(springSettled(state, 1));
});

test("spring: retarget keeps velocity for an inertia hand-off", () => {
  const state = advanceSpring(createSpring(0), SPRING_PRESETS.snappy, 100, 16);
  assert.ok(state.velocity > 0);
  // Reusing the same state with a new target keeps the carried velocity, so
  // the value keeps moving in the old direction before turning around.
  const redirected = advanceSpring(state, SPRING_PRESETS.snappy, 0, 16);
  assert.ok(redirected.value > state.value);
});

test("spring: dt is clamped so huge frames never diverge", () => {
  const clamped = advanceSpring(createSpring(0), SPRING_PRESETS.snappy, 100, 5000);
  const reference = advanceSpring(createSpring(0), SPRING_PRESETS.snappy, 100, 64);
  assert.deepEqual(clamped, reference);
  assert.ok(Number.isFinite(clamped.value));
  assert.ok(Number.isFinite(clamped.velocity));
});

test("tween: cubicBezier hits endpoints and stays monotonic", () => {
  const standard = cubicBezier(0.23, 1, 0.32, 1);
  assert.equal(standard(0), 0);
  assert.equal(standard(1), 1);
  let previous = 0;
  for (let t = 0.05; t <= 1; t += 0.05) {
    const value = standard(t);
    assert.ok(value >= previous, `monotonicity broken at t=${t}: ${value} < ${previous}`);
    previous = value;
  }
});

test("tween: standard curve is front-loaded, exit trails, emphasis overshoots", () => {
  assert.ok(MOTION_TWEENS.standard(0.3) > 0.6);
  assert.ok(MOTION_TWEENS.standard(0.3) > 0.3);
  assert.ok(MOTION_TWEENS.exit(0.3) < 0.15);
  let peak = 0;
  for (let t = 0; t <= 1; t += 0.02) {
    peak = Math.max(peak, MOTION_TWEENS.emphasis(t));
  }
  assert.ok(peak > 1, "emphasis should overshoot past 1");
});

test("animate: spring travels from -> to, completes, then the loop idles", () => {
  const fake = createFakeRaf();
  _setAnimationClockForTesting(fake.now, fake.raf);
  const values = [];
  let completed = false;
  animateValue({
    from: 0,
    to: 100,
    spring: SPRING_PRESETS.snappy,
    onUpdate: (value) => values.push(value),
    onComplete: () => {
      completed = true;
    },
  });
  assert.deepEqual(values, [0]);
  for (let i = 0; i < 500 && !completed; i += 1) fake.step();
  assert.equal(completed, true);
  assert.equal(values[values.length - 1], 100);
  assert.equal(fake.hasPending(), false);
});

test("animate: cancel stops updates and never completes", () => {
  const fake = createFakeRaf();
  _setAnimationClockForTesting(fake.now, fake.raf);
  const values = [];
  let completed = false;
  const handle = animateValue({
    from: 0,
    to: 100,
    spring: SPRING_PRESETS.snappy,
    onUpdate: (value) => values.push(value),
    onComplete: () => {
      completed = true;
    },
  });
  fake.step();
  fake.step();
  const seen = values.length;
  handle.cancel();
  for (let i = 0; i < 50; i += 1) fake.step();
  assert.equal(values.length, seen);
  assert.equal(completed, false);
});

test("animate: spring retarget preserves inertia", () => {
  const fake = createFakeRaf();
  _setAnimationClockForTesting(fake.now, fake.raf);
  const values = [];
  const handle = animateValue({
    from: 0,
    to: 100,
    spring: SPRING_PRESETS.snappy,
    onUpdate: (value) => values.push(value),
  });
  fake.step();
  fake.step();
  fake.step();
  const beforeRetarget = values[values.length - 1];
  handle.retarget(0);
  fake.step();
  assert.ok(values[values.length - 1] > beforeRetarget);
  handle.cancel();
});

// A burst of retargets between two frames (wheel-tick cadence) must integrate
// the full elapsed time: each retarget first folds the pending dt into the
// spring, so a mid-frame burst tracks the same trajectory as the equivalent
// plain spring integration. A clock-resetting retarget would stall instead.
test("animate: retarget bursts between frames keep real elapsed time", () => {
  let now = 0;
  let pending = null;
  _setAnimationClockForTesting(
    () => now,
    (callback) => {
      pending = callback;
    },
  );
  const frame = () => {
    const callback = pending;
    pending = null;
    if (callback) callback(now);
  };

  const values = [];
  const handle = animateValue({
    from: 0,
    to: 100,
    spring: SPRING_PRESETS.snappy,
    onUpdate: (value) => values.push(value),
  });
  now = 16;
  frame(); // frame at 16ms
  now = 20;
  handle.retarget(200); // burst: three retargets before the next frame
  now = 24;
  handle.retarget(300);
  now = 28;
  handle.retarget(400);
  now = 32;
  frame(); // frame at 32ms

  let reference = createSpring(0);
  reference = advanceSpring(reference, SPRING_PRESETS.snappy, 100, 16);
  reference = advanceSpring(reference, SPRING_PRESETS.snappy, 100, 4);
  reference = advanceSpring(reference, SPRING_PRESETS.snappy, 200, 4);
  reference = advanceSpring(reference, SPRING_PRESETS.snappy, 300, 4);
  reference = advanceSpring(reference, SPRING_PRESETS.snappy, 400, 4);
  assert.equal(values[values.length - 1], reference.value);
  handle.cancel();
});

test("animate: tween retarget restarts timing from the current value", () => {
  const fake = createFakeRaf();
  _setAnimationClockForTesting(fake.now, fake.raf);
  const values = [];
  let completed = false;
  const handle = animateValue({
    from: 0,
    to: 100,
    tween: { durationMs: 200, easing: (t) => t },
    onUpdate: (value) => values.push(value),
    onComplete: () => {
      completed = true;
    },
  });
  for (let i = 0; i < 6; i += 1) fake.step(); // 96ms in
  const midValue = values[values.length - 1];
  assert.ok(midValue > 40 && midValue < 60, `mid value ${midValue}`);
  handle.retarget(200);
  for (let i = 0; i < 12; i += 1) fake.step(); // 192ms after retarget
  assert.equal(completed, false);
  fake.step(); // 208ms after retarget
  assert.equal(completed, true);
  assert.equal(values[values.length - 1], 200);
});

test("flip: register/take round-trip and one-shot consumption", () => {
  registerFlipSource("cover", { x: 10, y: 20, width: 100, height: 120 }, 1000);
  assert.deepEqual(takeFlipSource("cover", 1500), { x: 10, y: 20, width: 100, height: 120 });
  assert.equal(takeFlipSource("cover", 1600), null);
  assert.equal(takeFlipSource("never-registered", 100), null);
});

test("flip: entries older than maxAgeMs expire", () => {
  registerFlipSource("stale", { x: 0, y: 0, width: 10, height: 10 }, 1000);
  assert.equal(takeFlipSource("stale", 2500), null); // 1500ms > 1000ms default

  registerFlipSource("fresh", { x: 1, y: 2, width: 3, height: 4 }, 1000);
  assert.deepEqual(takeFlipSource("fresh", 1999, 1200), { x: 1, y: 2, width: 3, height: 4 });
});

test("flip: computeFlipDelta aligns centers and scales size", () => {
  const delta = computeFlipDelta(
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 200, y: 100, width: 50, height: 50 },
  );
  assert.deepEqual(delta, { dx: -175, dy: -75, scaleX: 2, scaleY: 2 });

  const identity = computeFlipDelta(
    { x: 5, y: 5, width: 20, height: 20 },
    { x: 5, y: 5, width: 20, height: 20 },
  );
  assert.deepEqual(identity, { dx: 0, dy: 0, scaleX: 1, scaleY: 1 });
});

test("pageTransition: peer pages pivot along the navigation order", () => {
  const forward = resolvePageTransition("quickplay", "collection");
  assert.equal(forward.kind, "pivot");
  assert.equal(forward.direction, 1);
  assert.equal(forward.coverFlip, false);

  const backward = resolvePageTransition("settings", "collection");
  assert.equal(backward.kind, "pivot");
  assert.equal(backward.direction, -1);

  const intoPodcasts = resolvePageTransition("collection", "podcasts");
  assert.equal(intoPodcasts.kind, "pivot");
  assert.equal(intoPodcasts.direction, 1);

  const outOfPodcasts = resolvePageTransition("podcasts", "collection");
  assert.equal(outOfPodcasts.kind, "pivot");
  assert.equal(outOfPodcasts.direction, -1);

  const podcastsToSettings = resolvePageTransition("podcasts", "settings");
  assert.equal(podcastsToSettings.kind, "pivot");
  assert.equal(podcastsToSettings.direction, 1);

  const skip = resolvePageTransition("quickplay", "settings");
  assert.equal(skip.kind, "pivot");
  assert.equal(skip.direction, 1);

  assert.ok(forward.exitMs > 0 && forward.enterMs > forward.exitMs);
});

test("pageTransition: entering nowPlaying pushes with a cover flip", () => {
  const transition = resolvePageTransition("collection", "nowPlaying");
  assert.equal(transition.kind, "push");
  assert.equal(transition.direction, 1);
  assert.equal(transition.coverFlip, true);
});

test("pageTransition: leaving nowPlaying pops with a cover flip", () => {
  const transition = resolvePageTransition("nowPlaying", "quickplay");
  assert.equal(transition.kind, "pop");
  assert.equal(transition.direction, -1);
  assert.equal(transition.coverFlip, true);
});

test("pageTransition: same page resolves to a zero-length transition", () => {
  const transition = resolvePageTransition("settings", "settings");
  assert.equal(transition.exitMs, 0);
  assert.equal(transition.enterMs, 0);
  assert.equal(transition.coverFlip, false);
});
