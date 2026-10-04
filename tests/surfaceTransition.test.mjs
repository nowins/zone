import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { SurfaceTransition, snapshotSurface } from "../.tmp/visualizer-tests/motion/surfaceTransition.js";
import { resolvePageTransition } from "../.tmp/visualizer-tests/motion/pageTransition.js";
import { NAVIGATION_MOTION } from "../.tmp/visualizer-tests/motion/tokens.js";

function setup(t) {
  const dom = new JSDOM('<body><div class="shell"><audio></audio><main class="workspace"><section class="quickplay"><div class="quick-group"><button id="pin" data-collection-focus="pin">封面</button></div><div class="quickplay-viewport"></div></section></main></div></body>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window, animations = [];
  window.DOMMatrixReadOnly = class {
    constructor(value) {
      const numbers = value?.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      this.m41 = value?.startsWith("matrix(") ? numbers[4] : numbers[1] ?? 0;
      this.m42 = value?.startsWith("matrix(") ? numbers[5] : numbers[2] ?? 0;
    }
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const x = new window.DOMMatrixReadOnly(this.style.transform).m41;
    return { left: 48 + x, top: 106, right: 1132 + x, bottom: 686, width: 1084, height: 580 };
  };
  window.HTMLElement.prototype.getAnimations = function (options) {
    return animations.filter(a => !a.cancelled && (a.node === this || options?.subtree && this.contains(a.node)));
  };
  window.HTMLElement.prototype.animate = function (frames, options) {
    const animation = { node: this, effect: { target: this }, frames, options, cancelled: false, onfinish: null,
      cancel() { this.cancelled = true; }, finish() { this.onfinish?.(); } };
    animations.push(animation); return animation;
  };
  const host = document.querySelector("main"), motion = new SurfaceTransition(host);
  const mount = (className) => { const page = document.createElement("section"); page.className = className; page.innerHTML = '<div class="quick-group">内容</div>'; host.replaceChildren(page); return page; };
  return { document, host, motion, animations, mount };
}

test("outgoing pixels and the interactive target coexist; cleanup retains one audio", t => {
  const { document, motion, animations, mount } = setup(t);
  document.querySelector('.quickplay-viewport').scrollLeft = 340;
  motion.prepare("quickplay", "collection", resolvePageTransition("quickplay", "collection"), true);
  const departure = document.querySelector('.motion-departure');
  assert.equal(departure.inert, true);
  assert.equal(departure.getAttribute('aria-hidden'), 'true');
  assert.equal(departure.querySelector('[data-collection-focus]'), null);
  assert.equal(departure.querySelector('#pin'), null);
  assert.equal(departure.querySelector('.quickplay-viewport').scrollLeft, 340);
  const current = mount('content-band collection-connected');
  assert.equal(motion.enter(), true);
  assert.ok(animations.some(a => a.node === current && a.options.duration === NAVIGATION_MOTION.enter));
  assert.ok(animations.some(a => a.node === current && a.options.duration === NAVIGATION_MOTION.fade));
  assert.equal(document.querySelectorAll('audio').length, 1);
  animations[0].finish();
  assert.equal(document.querySelector('.motion-departure'), null);
  motion.stop();
  assert.ok(animations.every(a => a.cancelled));
});

test("a rapid return picks up the departing page frame instead of disabling or restarting motion", t => {
  const { document, motion, animations, mount } = setup(t);
  motion.prepare("quickplay", "collection", resolvePageTransition("quickplay", "collection"), true);
  const original = document.querySelector('.motion-departure > section');
  original.style.transform = 'matrix(1, 0, 0, 1, -18, 0)'; original.style.opacity = '0.6';
  const collection = mount('content-band'); motion.enter();
  collection.style.transform = 'matrix(1, 0, 0, 1, 35, 0)'; collection.style.opacity = '0.8';
  motion.prepare("collection", "quickplay", resolvePageTransition("collection", "quickplay"), true);
  assert.equal(document.querySelectorAll('.motion-departure').length, 1, "rapid input cannot accumulate ghosts");
  const ghost = document.querySelector('.motion-departure');
  assert.equal(ghost.style.left, '48px', "transformed bounds are not translated twice");
  assert.equal(ghost.firstElementChild.style.transform, collection.style.transform);
  const returning = mount('quickplay'); motion.enter();
  assert.equal(animations.findLast(a => a.node === returning && a.options.duration === NAVIGATION_MOTION.enter).frames[0].transform, original.style.transform);
  assert.equal(animations.findLast(a => a.node === returning && a.options.duration === NAVIGATION_MOTION.fade).frames[0].opacity, '0.6');
  motion.stop(); assert.equal(document.querySelector('.motion-departure'), null);
});

test("lazy content receives its arrival when mounted; reduced motion and disposal create no ghost", t => {
  const { document, host, motion, animations, mount } = setup(t);
  motion.prepare("quickplay", "settings", resolvePageTransition("quickplay", "settings"), true);
  host.replaceChildren(document.createElement('div'));
  assert.equal(motion.enter(), false);
  const settings = mount('content-band settings-page');
  assert.equal(motion.enter(), true);
  assert.ok(animations.some(a => a.node === settings && a.options.duration === NAVIGATION_MOTION.enter));
  motion.prepare("settings", "collection", resolvePageTransition("settings", "collection"), false);
  mount('content-band'); motion.enter();
  assert.equal(document.querySelector('.motion-departure'), null);
  assert.ok(animations.every(a => a.cancelled));
});

test("a long track list snapshots visible rows with two row measurements and keeps its scroll position", t => {
  const { document, host } = setup(t);
  const root = document.createElement('section');
  root.className = 'content-band';
  const area = document.createElement('div');
  area.className = 'collection-track-scroll'; area.dataset.collectionScroll = 'tracks:songs';
  area.scrollTop = 4400;
  let reads = 0;
  for (let index = 0; index < 2000; index++) {
    const row = document.createElement('div'); row.className = 'collection-track-row'; row.textContent = `歌曲 ${index}`;
    row.getBoundingClientRect = () => { reads++; const top = 106 + index * 44 - area.scrollTop; return { top, bottom: top + 44, height: 44, width: 1084 }; };
    area.append(row);
  }
  root.append(area); host.replaceChildren(root);
  const snapshot = snapshotSurface(root);
  const saved = snapshot.node.querySelector('.collection-track-scroll');
  assert.equal(reads, 2, "no scan across every song rectangle");
  assert.ok(saved.querySelectorAll('.collection-track-row').length < 20, "the copied DOM is bounded by the viewport");
  assert.equal(saved.scrollTop, 4400);
  assert.equal(saved.querySelector('.collection-track-row').textContent, '歌曲 98');
  assert.equal(saved.firstElementChild.style.height, '4312px');
  assert.equal(area.children.length, 2000, "the live list is never changed");
  snapshot.layer.remove();
});
