import assert from "node:assert/strict";
import test from "node:test";
import {
  attachCoverReturn, playCoverFlip, registerCoverFlipSource,
  rememberCoverReturnTarget, startCoverReturn,
} from "../.tmp/visualizer-tests/motion/coverFlip.js";
import { takeFlipSource } from "../.tmp/visualizer-tests/motion/flip.js";
import { NOW_PLAYING_MOTION } from "../.tmp/visualizer-tests/motion/tokens.js";

const BAR = { x: 10, y: 20, width: 48, height: 48 };
const CARD = { x: 300, y: 200, width: 240, height: 240 };
const ID = "cover:behavior";

// Control WAAPI completion without emulating easing or image loading. Browser
// checks exercise real interpolation; these tests guard ownership and timing.
function withDom(run) {
  let now = 0;
  const animations = [], draws = [], created = [];
  const media = Object.assign(new EventTarget(), { matches: false });
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = Object.assign(new EventTarget(), { matchMedia: () => media });
  function element(rect, image = { complete: true, naturalWidth: 600, naturalHeight: 600 }) {
    return {
      rect, image, style: { visibility: "" }, dataset: {}, attributes: {}, isConnected: true,
      measures: 0,
      querySelector() { return this.image; },
      getBoundingClientRect() { this.measures++; return this.rect; },
      setAttribute(name, value) { this.attributes[name] = value; },
      getContext() { return { drawImage: (...args) => draws.push(args) }; },
      remove() { this.isConnected = false; },
      animate(frames, options) {
        const animation = {
          frames, options, end: now + options.duration, cancelled: false, completed: false, onfinish: null,
          cancel() { this.cancelled = true; },
        };
        animations.push(animation);
        return animation;
      },
    };
  }
  document.body = { appendChild() {} };
  document.createElement = tag => {
    assert.equal(tag, "canvas", "flight snapshots decoded art without another image request");
    const clone = element(BAR);
    created.push(clone);
    return clone;
  };
  const globals = { document, window, performance: { now: () => now }, getComputedStyle: () => ({ borderRadius: "0px" }) };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.entries(globals).forEach(([key, value]) => Object.defineProperty(globalThis, key, { configurable: true, value }));
  const dom = {
    document, window, media, element, animations, created, draws,
    live: () => created.filter(node => node.isConnected),
    tick(ms) {
      const until = now + ms;
      for (;;) {
        const next = animations.filter(a => !a.cancelled && !a.completed && a.end <= until).sort((a, b) => a.end - b.end)[0];
        if (!next) break;
        now = next.end;
        next.completed = true;
        next.onfinish?.();
      }
      now = until;
    },
    source() { return registerCoverFlipSource(ID, element(BAR)); },
  };
  try { run(dom); } finally {
    registerCoverFlipSource("cleanup", element(BAR, null));
    takeFlipSource("cleanup");
    takeFlipSource(ID);
    saved.forEach(([key, descriptor]) => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
}

test("cover flip: missing, undecoded and zero-size artwork never hides the real cover", () => withDom(dom => {
  const target = dom.element(CARD);
  for (const source of [BAR, { ...dom.source(), width: 0 }, { ...BAR, image: { complete: false, naturalWidth: 600, naturalHeight: 600 } }]) {
    assert.equal(playCoverFlip({ id: ID, source, target }), null);
  }
  assert.equal(playCoverFlip({ id: ID, source: dom.source(), target: dom.element({ ...CARD, height: 0 }) }), null);
  assert.equal(dom.live().length, 0);
  assert.equal(target.style.visibility, "");
}));

test("cover flip: decoded artwork moves immediately with a bounded compositor tween", () => withDom(dom => {
  const source = dom.source(), target = dom.element(CARD);
  source.image.decode = () => assert.fail("the visible image must not be decoded again");
  const handle = playCoverFlip({ id: ID, source, target });
  assert.ok(handle);
  assert.equal(dom.animations.length, 1, "flight starts synchronously, without a decode or rAF gate");
  assert.equal(dom.draws[0][0], source.image);
  assert.equal(target.style.visibility, "hidden");
  const flight = dom.animations[0];
  assert.deepEqual(flight.frames, [
    { transform: "translate3d(0px, 0px, 0) scale(1, 1)" },
    { transform: "translate3d(386px, 276px, 0) scale(5, 5)" },
  ]);
  assert.equal(flight.options.duration, NOW_PLAYING_MOTION.coverEnter);
  assert.ok(flight.options.duration < 300);
  assert.equal(dom.live()[0].style.filter, undefined);
  const measurements = target.measures;
  dom.tick(NOW_PLAYING_MOTION.coverEnter);
  assert.equal(target.measures, measurements, "the endpoint is not measured every frame");
  assert.equal(target.style.visibility, "", "the real outline takes over at landing");
  assert.equal(dom.live().length, 1, "art stays opaque during the short outline handoff");
  dom.tick(NOW_PLAYING_MOTION.coverHandoff);
  assert.equal(dom.live().length, 0);
  handle.cancel();
  assert.equal(target.style.visibility, "", "completed cleanup is idempotent");
}));

test("cover return starts before the bar exists and does not replay on its mount", () => withDom(dom => {
  rememberCoverReturnTarget(dom.element(BAR));
  const outgoing = dom.element(CARD);
  startCoverReturn(ID, outgoing);
  assert.equal(dom.live().length, 1, "click starts a return before navigation mounts the bar");
  assert.equal(outgoing.style.visibility, "hidden");
  assert.equal(takeFlipSource(ID), null, "a live return must not leave a second mount-triggered flight");
  dom.tick(160);
  const target = dom.element(BAR);
  assert.equal(attachCoverReturn(ID, target), true);
  assert.equal(target.style.visibility, "hidden");
  assert.equal(attachCoverReturn(ID, target), false, "StrictMode remount does not attach twice");
  assert.equal(dom.animations.length, 1);
  assert.ok(NOW_PLAYING_MOTION.coverExit < NOW_PLAYING_MOTION.coverEnter);
  dom.tick(NOW_PLAYING_MOTION.coverExit - 160);
  assert.equal(dom.live().length, 0);
  assert.equal(target.style.visibility, "");
  assert.equal(outgoing.style.visibility, "");
}));

test("cover return corrects a reflowed endpoint from its current position within the original budget", () => withDom(dom => {
  rememberCoverReturnTarget(dom.element(BAR));
  startCoverReturn(ID, dom.element(CARD));
  dom.tick(160);
  dom.live()[0].rect = { x: 25, y: 31, width: 60, height: 60 };
  const target = dom.element({ ...BAR, x: 30 });
  attachCoverReturn(ID, target);
  assert.equal(dom.animations.length, 2);
  assert.equal(dom.animations[0].cancelled, true);
  assert.equal(dom.animations[1].options.duration, NOW_PLAYING_MOTION.coverExit - 160);
  assert.notEqual(dom.animations[1].frames[0].transform, dom.animations[0].frames[0].transform);
  dom.tick(NOW_PLAYING_MOTION.coverExit - 160);
  assert.equal(dom.live().length, 0);
  assert.equal(target.style.visibility, "");
}));

test("a late bar mount cannot replay a completed or stale return for another track", () => withDom(dom => {
  rememberCoverReturnTarget(dom.element(BAR));
  startCoverReturn(ID, dom.element(CARD));
  dom.tick(NOW_PLAYING_MOTION.coverExit + 40);
  const target = dom.element(BAR);
  assert.equal(attachCoverReturn("cover:other", target), false);
  assert.equal(attachCoverReturn(ID, target), true);
  assert.equal(target.style.visibility, "");
  assert.equal(dom.animations.length, 1);
  startCoverReturn(ID, dom.element(CARD));
  dom.tick(1001);
  assert.equal(attachCoverReturn(ID, target), false);
  assert.equal(dom.live().length, 0);
}));

test("reversing preserves visible geometry and the old view cannot cancel the new return", () => withDom(dom => {
  rememberCoverReturnTarget(dom.element(BAR));
  const target = dom.element(CARD), source = dom.source();
  const enter = playCoverFlip({ id: ID, source, target });
  dom.live()[0].rect = { x: 180, y: 120, width: 160, height: 160 };
  startCoverReturn(ID, target);
  assert.equal(dom.live().length, 1);
  assert.equal(dom.live()[0].style.left, "180px");
  assert.equal(dom.live()[0].style.width, "160px");
  assert.equal(dom.draws.at(-1)[0], source.image);
  enter.cancel();
  assert.equal(dom.live().length, 1, "departing view cleanup owns only its old entry flight");
  dom.tick(NOW_PLAYING_MOTION.coverExit);
  assert.equal(dom.live().length, 0);
  assert.equal(target.style.visibility, "");
}));

test("cancel, hidden, resize and a reduced-motion change restore all hidden covers", () => withDom(dom => {
  for (const stop of [
    handle => handle.cancel(),
    () => { dom.document.hidden = true; dom.document.dispatchEvent(new Event("visibilitychange")); },
    () => dom.window.dispatchEvent(new Event("resize")),
    () => { dom.media.matches = true; dom.media.dispatchEvent(new Event("change")); },
  ]) {
    dom.document.hidden = false;
    dom.media.matches = false;
    const target = dom.element(CARD);
    const handle = playCoverFlip({ id: ID, source: dom.source(), target });
    const animation = dom.animations.at(-1);
    stop(handle);
    assert.equal(dom.live().length, 0);
    assert.equal(animation.cancelled, true);
    assert.equal(target.style.visibility, "");
    dom.tick(1000);
    assert.equal(dom.live().length, 0, "an old completion cannot resurrect a clone");
  }
}));

test("reduced motion skips spatial flights before any artwork is hidden", () => withDom(dom => {
  dom.media.matches = true;
  const target = dom.element(CARD);
  assert.equal(playCoverFlip({ id: ID, source: dom.source(), target }), null);
  assert.equal(dom.animations.length, 0);
  assert.equal(target.style.visibility, "");
}));
