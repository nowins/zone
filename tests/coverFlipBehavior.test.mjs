import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetAnimationClockForTesting,
  _setAnimationClockForTesting,
} from "../.tmp/visualizer-tests/motion/animate.js";
import { playCoverFlip } from "../.tmp/visualizer-tests/motion/coverFlip.js";

// Rects chosen so the flight delta is exact: the dock center (420, 320) minus
// the source center (34, 44) is (386, 276), and 240/48 gives a 5x growth.
const SOURCE_RECT = { x: 10, y: 20, width: 48, height: 48 };
const TARGET_RECT = { x: 300, y: 200, width: 240, height: 240 };
const FLIGHT_START_TRANSFORM = "translate3d(0px, 0px, 0) scale(1, 1)";
const FLIGHT_END_TRANSFORM = "translate3d(386px, 276px, 0) scale(5, 5)";

function createMockElement(rect) {
  return {
    style: {},
    removed: false,
    children: [],
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    remove() {
      this.removed = true;
    },
    getBoundingClientRect() {
      return rect;
    },
  };
}

// Minimal DOM surface coverFlip touches: document.createElement("img") with a
// controllable decode(), document.body.appendChild, window rAF/setTimeout for
// the dock follow loop and the decode fallback, getComputedStyle for the
// border radius. Global mocks are restored in each test's finally block so
// sibling test files sharing the process never see them.
function installDomMocks() {
  const body = createMockElement({ x: 0, y: 0, width: 0, height: 0 });
  body.appendCount = 0;
  const baseAppendChild = body.appendChild.bind(body);
  body.appendChild = (child) => {
    body.appendCount += 1;
    return baseAppendChild(child);
  };

  const createdImages = [];
  const timeouts = [];
  const followCallbacks = new Map();
  let nextFollowId = 0;

  const mocks = {
    document: {
      body,
      createElement(tag) {
        const element = createMockElement({ x: 0, y: 0, width: 0, height: 0 });
        element.tagName = tag;
        element.decode = () =>
          new Promise((resolve, reject) => {
            element.decodeResolve = resolve;
            element.decodeReject = reject;
          });
        createdImages.push(element);
        return element;
      },
    },
    window: {
      setTimeout(callback, ms) {
        timeouts.push({ callback, ms });
        return timeouts.length;
      },
      requestAnimationFrame(callback) {
        nextFollowId += 1;
        followCallbacks.set(nextFollowId, callback);
        return nextFollowId;
      },
      cancelAnimationFrame(id) {
        followCallbacks.delete(id);
      },
    },
    getComputedStyle: () => ({ borderRadius: "6px" }),
  };

  const saved = Object.entries(mocks).map(([name, value]) => {
    const entry = { name, existed: name in globalThis, previous: globalThis[name] };
    globalThis[name] = value;
    return entry;
  });

  return {
    body,
    createdImages,
    timeoutCount: () => timeouts.length,
    fireTimeouts() {
      for (const { callback } of timeouts.splice(0)) callback();
    },
    followCount: () => followCallbacks.size,
    runFollowFrame() {
      const callbacks = [...followCallbacks.values()];
      followCallbacks.clear();
      for (const callback of callbacks) callback();
    },
    restore() {
      for (const { name, existed, previous } of saved) {
        if (existed) globalThis[name] = previous;
        else delete globalThis[name];
      }
    },
  };
}

// Same fake-clock shape as tests/motion.test.mjs: animateValue's shared loop
// only ever has one outstanding rAF, so a single pending slot is enough.
function createFakeClock() {
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

function flushMicrotasks() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function createTarget() {
  const target = createMockElement(TARGET_RECT);
  target.style.visibility = "";
  return target;
}

/** Steps the fake clock until the flight spring settles on the target. */
function flyToSettle(clock, isDocked) {
  for (let i = 0; i < 600 && !isDocked(); i += 1) clock.step();
}

test("cover flip: zero-size rects bail out before touching the DOM", () => {
  const dom = installDomMocks();
  const clock = createFakeClock();
  _setAnimationClockForTesting(clock.now, clock.raf);
  try {
    const target = createTarget();
    const zeroSource = { x: 5, y: 5, width: 0, height: 120 };
    const flatTarget = createMockElement({ x: 0, y: 0, width: 200, height: 0 });
    flatTarget.style.visibility = "";

    playCoverFlip({ source: zeroSource, target, imageSrc: "zone-audio://a" }).cancel();
    playCoverFlip({ source: SOURCE_RECT, target: flatTarget, imageSrc: "zone-audio://a" }).cancel();

    assert.equal(dom.body.appendCount, 0, "no clone is appended for a zero-size rect");
    assert.equal(dom.createdImages.length, 0, "no img is even created");
    assert.equal(target.style.visibility, "", "the real cover is never hidden");
    assert.equal(flatTarget.style.visibility, "");
  } finally {
    _resetAnimationClockForTesting();
    dom.restore();
  }
});

test("cover flip: cancel before decode removes the clone and blocks the flight", async () => {
  const dom = installDomMocks();
  const clock = createFakeClock();
  _setAnimationClockForTesting(clock.now, clock.raf);
  try {
    const target = createTarget();
    let docked = 0;
    const handle = playCoverFlip({
      source: SOURCE_RECT,
      target,
      imageSrc: "zone-audio://a",
      onDocked: () => {
        docked += 1;
      },
    });
    const clone = dom.createdImages[0];
    assert.equal(dom.body.appendCount, 1);
    assert.equal(target.style.visibility, "hidden");
    assert.equal(clone.removed, false);

    handle.cancel();
    assert.equal(clone.removed, true, "cancel detaches the clone");
    assert.equal(target.style.visibility, "", "cancel restores the real cover");
    handle.cancel(); // documented as idempotent: a second call must not throw
    assert.equal(clone.removed, true);

    // A decode resolving after the cancel must not start the spring.
    clone.decodeResolve();
    await flushMicrotasks();
    for (let i = 0; i < 20; i += 1) clock.step();
    assert.equal(clone.style.transform, undefined, "no transform is written after cancel");
    assert.equal(docked, 0);
    assert.equal(clock.hasPending(), false, "no animation was ever scheduled");
  } finally {
    _resetAnimationClockForTesting();
    dom.restore();
  }
});

test("cover flip: the flight waits for image decode, then docks once", async () => {
  const dom = installDomMocks();
  const clock = createFakeClock();
  _setAnimationClockForTesting(clock.now, clock.raf);
  try {
    const target = createTarget();
    let docked = 0;
    playCoverFlip({
      source: SOURCE_RECT,
      target,
      imageSrc: "zone-audio://a",
      onDocked: () => {
        docked += 1;
      },
    });
    const clone = dom.createdImages[0];
    assert.equal(target.style.visibility, "hidden", "the real cover hides while the clone flies");
    assert.equal(clone.style.borderRadius, "6px", "the clone inherits the cover border radius");
    assert.equal(clone.attributes["aria-hidden"], "true");

    // While decode() is pending, advancing the animation clock starts nothing.
    await flushMicrotasks();
    for (let i = 0; i < 20; i += 1) clock.step();
    assert.equal(clone.style.transform, undefined, "the spring is gated on decode");
    assert.equal(docked, 0);

    clone.decodeResolve();
    await flushMicrotasks();
    assert.equal(clone.style.transform, FLIGHT_START_TRANSFORM, "the spring opens at the source rect");

    clock.step();
    clock.step();
    assert.notEqual(clone.style.transform, FLIGHT_START_TRANSFORM, "the spring advances with the clock");

    flyToSettle(clock, () => docked > 0);
    assert.equal(docked, 1, "onDocked fires exactly once, at rest");
    assert.equal(clone.style.transform, FLIGHT_END_TRANSFORM, "the clone lands exactly on the target");
    // Without a dock period the hand-off runs immediately after landing.
    assert.equal(clone.removed, true);
    assert.equal(target.style.visibility, "");
    assert.equal(clock.hasPending(), false, "the shared animation loop idles out");
  } finally {
    _resetAnimationClockForTesting();
    dom.restore();
  }
});

test("cover flip: a stalled decode is bounded by the 400ms fallback", async () => {
  const dom = installDomMocks();
  const clock = createFakeClock();
  _setAnimationClockForTesting(clock.now, clock.raf);
  try {
    const target = createTarget();
    let docked = 0;
    playCoverFlip({
      source: SOURCE_RECT,
      target,
      imageSrc: "zone-audio://broken",
      onDocked: () => {
        docked += 1;
      },
    });
    const clone = dom.createdImages[0];

    await flushMicrotasks();
    for (let i = 0; i < 10; i += 1) clock.step();
    assert.equal(clone.style.transform, undefined, "decode never resolves and the fallback has not fired");
    assert.equal(dom.timeoutCount(), 1, "the decode fallback timer is armed");

    dom.fireTimeouts(); // the image is broken; the entrance must not stall
    await flushMicrotasks();
    assert.equal(clone.style.transform, FLIGHT_START_TRANSFORM, "the fallback releases the flight");

    flyToSettle(clock, () => docked > 0);
    assert.equal(docked, 1);
    assert.equal(clone.removed, true);
    assert.equal(target.style.visibility, "");
  } finally {
    _resetAnimationClockForTesting();
    dom.restore();
  }
});

test("cover flip: holdUntil parks the clone on the target until the hand-off", async () => {
  const dom = installDomMocks();
  const clock = createFakeClock();
  _setAnimationClockForTesting(clock.now, clock.raf);
  try {
    const target = createTarget();
    let docked = 0;
    let releaseHold = null;
    playCoverFlip({
      source: SOURCE_RECT,
      target,
      imageSrc: "zone-audio://a",
      holdUntil: () =>
        new Promise((resolve) => {
          releaseHold = resolve;
        }),
      onDocked: () => {
        docked += 1;
      },
    });
    const clone = dom.createdImages[0];
    clone.decodeResolve();
    await flushMicrotasks();
    assert.ok(releaseHold, "holdUntil is consulted as soon as the flight starts");

    flyToSettle(clock, () => docked > 0);
    assert.equal(docked, 1);
    // Parked: the clone outlives the landing and keeps following the target,
    // which stays hidden underneath.
    assert.equal(clone.removed, false, "the clone stays while docked");
    assert.equal(target.style.visibility, "hidden");
    assert.equal(dom.followCount(), 1, "the dock follow loop is running");
    dom.runFollowFrame();
    assert.equal(clone.style.transform, FLIGHT_END_TRANSFORM, "the follow frame re-glues the clone");
    assert.equal(dom.followCount(), 1, "the follow loop re-queues itself");

    releaseHold();
    await flushMicrotasks();
    assert.equal(clone.removed, true, "the hand-off removes the clone");
    assert.equal(target.style.visibility, "", "the hand-off reveals the real cover");
    assert.equal(dom.followCount(), 0, "the follow loop is cancelled");
  } finally {
    _resetAnimationClockForTesting();
    dom.restore();
  }
});
