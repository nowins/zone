import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { SurfaceTransition, snapshotSurface } from "../.tmp/visualizer-tests/motion/surfaceTransition.js";
import { resolvePageTransition } from "../.tmp/visualizer-tests/motion/pageTransition.js";
import { NAVIGATION_MOTION, BROWSE_MOTION } from "../.tmp/visualizer-tests/motion/tokens.js";
import { playBrowseTransition, prepareBrowseTransition } from "../.tmp/visualizer-tests/motion/browseTransition.js";

function setup(t) {
  const dom = new JSDOM('<body><div class="shell"><audio></audio><main class="workspace"><section class="quickplay"><div class="quickplay-ghost">quickplay</div><div class="quickplay-viewport"><div class="quick-group"><button id="pin" data-collection-focus="pin">封面</button></div></div></section></main></div></body>', { pretendToBeVisual: true });
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
    const animation = { node: this, effect: { target: this }, frames, options, cancelled: false, playState: 'running', onfinish: null,
      cancel() { this.cancelled = true; this.playState = 'idle'; }, finish() { this.playState = 'finished'; this.onfinish?.(); } };
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
  assert.ok(departure.classList.contains('quickplay'), 'content snapshots retain panorama sizing and scoped styles');
  assert.equal(departure.querySelector('[data-collection-focus]'), null);
  assert.equal(departure.querySelector('#pin'), null);
  assert.equal(departure.querySelector('.quickplay-viewport').scrollLeft, 340);
  const current = mount('content-band collection-connected');
  current.innerHTML = '<div class="collection-toolbar">分类和搜索</div><div class="collection-content"><ul class="collection-artist-index"><li>艺术家</li></ul></div>';
  assert.equal(motion.enter(), true);
  const arrivals = animations.filter(a => current.contains(a.node));
  assert.ok(arrivals.length > 0);
  assert.ok(arrivals.every(a => current.querySelector('.collection-content').contains(a.node)));
  assert.ok(arrivals.every(a => a.options.duration === (a.node.matches('li') ? BROWSE_MOTION.reveal : BROWSE_MOTION.duration)));
  assert.equal(document.querySelectorAll('audio').length, 1);
  animations[0].finish();
  assert.equal(document.querySelector('.motion-departure'), null);
  motion.stop();
  assert.ok(animations.every(a => a.cancelled));
});

test("a rapid return picks up the departing page frame instead of disabling or restarting motion", t => {
  const { document, motion, animations, mount } = setup(t);
  motion.prepare("quickplay", "collection", resolvePageTransition("quickplay", "collection"), true);
  const original = document.querySelector('.motion-departure > .quickplay-viewport');
  original.style.transform = 'matrix(1, 0, 0, 1, -18, 0)'; original.style.opacity = '0.6';
  const collection = mount('content-band'); motion.enter();
  collection.style.transform = 'matrix(1, 0, 0, 1, 35, 0)'; collection.style.opacity = '0.8';
  motion.prepare("collection", "quickplay", resolvePageTransition("collection", "quickplay"), true);
  assert.equal(document.querySelectorAll('.motion-departure').length, 1, "rapid input cannot accumulate ghosts");
  const ghost = document.querySelector('.motion-departure');
  assert.equal(ghost.style.left, '48px', "transformed bounds are not translated twice");
  assert.equal(ghost.firstElementChild.style.transform, collection.style.transform);
  const returning = mount('quickplay');
  returning.innerHTML = '<div class="quickplay-ghost">quickplay</div><div class="quickplay-viewport"><div class="quick-group"><button>封面</button></div></div>';
  motion.enter();
  const group = returning.querySelector('.quick-group');
  assert.equal(animations.findLast(a => a.node === group && a.options.duration === BROWSE_MOTION.duration).frames[0].transform, 'translate3d(-18px,0px,0)');
  assert.equal(animations.findLast(a => a.node === group && a.options.duration === BROWSE_MOTION.reveal).frames[0].opacity, '0.6');
  assert.ok(animations.filter(a => returning.contains(a.node)).every(a => group.contains(a.node)), 'the page and panorama depth planes never inherit arrival movement');
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

test("cold podcast loading keeps chrome visible and reserves one entrance for the real cards", t => {
  const { motion, animations, mount } = setup(t);
  motion.prepare('quickplay', 'podcasts', resolvePageTransition('quickplay', 'podcasts'), true);
  const page = mount('content-band podcast-page');
  page.innerHTML = '<header>播客分区</header><main class="podcast-screen"><section class="podcast-content-section"><div class="podcast-section-title">已关注</div><div class="podcast-loading-state">正在读取</div></section></main>';
  assert.equal(motion.enter(), false, 'a loading placeholder must not consume the real content entrance');
  assert.equal(page.querySelector('.podcast-screen').dataset.browseWaiting, 'true', 'the heading cannot flash at its final position while data is deferred');
  assert.equal(animations.filter(a => page.contains(a.node)).length, 0);
  const section = page.querySelector('.podcast-content-section');
  section.innerHTML = '<div class="podcast-section-title">已关注</div><article class="podcast-library-show" data-podcast-show="one">节目一</article>';
  assert.equal(motion.enter(), true);
  assert.equal(page.querySelector('.podcast-screen').dataset.browseWaiting, undefined);
  assert.equal(animations.filter(a => a.node === section).length, 1, 'the card region owns only movement');
  assert.equal(animations.find(a => a.node === section.lastElementChild).options.duration, BROWSE_MOTION.reveal);
  assert.equal(animations.find(a => a.node === section.firstElementChild).frames[0].opacity, 0, 'the heading reveals with the real cards');
  const count = animations.length;
  section.firstElementChild.textContent = '节目标题更新';
  assert.equal(motion.enter(), true);
  assert.equal(animations.length, count, 'later data changes cannot replay the entry');
  motion.stop();
});

test('abandoning deferred podcast data releases the hidden heading without replay', t => {
  const { motion, mount } = setup(t);
  motion.prepare('quickplay', 'podcasts', resolvePageTransition('quickplay', 'podcasts'), true);
  const page = mount('content-band podcast-page');
  page.innerHTML = '<main class="podcast-screen"><section class="podcast-content-section"><div class="podcast-section-title">已关注</div><div class="podcast-loading-state">正在读取</div></section></main>';
  motion.enter();
  const screen = page.querySelector('main');
  assert.equal(screen.dataset.browseWaiting, 'true');
  motion.stop();
  assert.equal(screen.dataset.browseWaiting, undefined);
});

test('collection playlist returns through podcasts with a stationary divider and one detail animation', t => {
  const { motion, animations, mount } = setup(t);
  const playlist = () => {
    const page = mount('content-band collection-connected');
    page.innerHTML = '<div class="collection-content"><div class="playlist-list">左栏</div><section class="playlist-content"><div class="playlist-detail"><header class="playlist-heading">喜欢的歌曲</header><section class="collection-track-list">歌曲</section></div></section></div>';
    return page;
  };
  playlist();
  motion.prepare('collection', 'podcasts', resolvePageTransition('collection', 'podcasts'), true);
  mount('content-band podcast-page').innerHTML = '<main class="podcast-screen"><section class="podcast-content-section">播客内容</section></main>';
  motion.enter();
  animations.find(a => !a.cancelled && a.node.closest('.motion-departure'))?.finish();
  motion.prepare('podcasts', 'collection', resolvePageTransition('podcasts', 'collection'), true);
  const returned = playlist();
  motion.enter();
  const detail = returned.querySelector('.playlist-detail');
  const current = animations.filter(a => !a.cancelled && returned.contains(a.node));
  assert.equal(current.length, 2);
  assert.ok(current.every(a => a.node === detail), 'neither the divider nor the sidebar nor individual rows move');
  assert.equal(current[0].frames[0].transform, `translate3d(${BROWSE_MOTION.drift}px,0,0)`);
  assert.equal(current[1].frames[0].opacity, 0);
  motion.stop();
});

test("internal browsing takes over the top-level departure without accumulating old pages", t => {
  const { document, motion, animations, mount } = setup(t);
  motion.prepare('quickplay', 'collection', resolvePageTransition('quickplay', 'collection'), true);
  const page = mount('content-band collection-connected');
  page.innerHTML = '<div class="collection-content"><section class="collection-track-list">歌曲</section></div>';
  motion.enter();
  const topDeparture = animations[0];
  assert.equal(document.querySelectorAll('.motion-departure').length, 1);
  prepareBrowseTransition(page, 'songs', 'albums', -1);
  assert.equal(topDeparture.cancelled, true, 'internal navigation releases the previous top-level pixels without settling live data');
  assert.equal(document.querySelectorAll('.motion-departure').length, 1);
  assert.ok(document.querySelector('.motion-departure .collection-track-list'));
  const stop = playBrowseTransition(page, -1);
  stop(); motion.stop();
  assert.equal(document.querySelector('.motion-departure'), null);
});

test("page arrival reveals a coherent text region and real input settles its current frame", t => {
  const { document, motion, animations, mount } = setup(t);
  motion.prepare('quickplay', 'collection', resolvePageTransition('quickplay', 'collection'), true);
  const page = mount('content-band collection-connected');
  page.innerHTML = '<div class="collection-toolbar">歌曲</div><div class="collection-content"><div class="collection-track-head">表头</div><div class="collection-track-scroll" data-collection-scroll="songs"></div></div>';
  const area = page.querySelector('.collection-track-scroll');
  for (let i = 0; i < 80; i++) {
    const row = document.createElement('div'); row.className = 'collection-track-row'; row.dataset.collectionAnchor = `${i}`;
    row.getBoundingClientRect = () => ({ top: 106 + i * 44, bottom: 150 + i * 44, height: 44 });
    area.append(row);
  }
  motion.enter();
  assert.equal(area.style.overflowAnchor, 'none');
  assert.equal(animations.filter(a => a.node.className === 'collection-track-row').length, 0, 'no row has an independent reveal');
  const arrivals = animations.filter(a => a.node === area);
  assert.equal(arrivals.length, 2, 'the text region owns separate alpha and movement');
  assert.ok(arrivals.every(a => a.options.delay === 0));
  area.dispatchEvent(new document.defaultView.Event('scroll'));
  assert.ok(arrivals.every(a => !a.cancelled), 'same-position restoration does not erase the build-in');
  arrivals.forEach(a => { a.node.style.transform = 'matrix(1, 0, 0, 1, 0, 7)'; a.node.style.opacity = '0.5'; });
  const input = new document.defaultView.Event('wheel', { bubbles: true, cancelable: true });
  area.dispatchEvent(input);
  assert.equal(input.defaultPrevented, false);
  assert.ok(arrivals.every(a => a.cancelled));
  const settling = animations.filter(a => !a.cancelled);
  assert.equal(settling.filter(a => a.node === area).length, 1, 'settling samples alpha and translation together once');
  assert.equal(settling.find(a => a.node === area).frames[0].opacity, '0.5');
  assert.equal(settling.filter(a => a.node.className === 'collection-track-row').length, 0);
  area.dispatchEvent(input);
  assert.equal(animations.filter(a => !a.cancelled).length, settling.length, 'continuing input never restarts the settle');
  motion.stop();
  assert.equal(area.style.overflowAnchor, '');
  assert.ok(animations.every(a => a.cancelled));
});

test("snapshot range uses settled row spacing during staggered content motion", t => {
  const { document, host } = setup(t);
  const root = document.createElement('section'); root.className = 'content-band';
  const area = document.createElement('div'); area.className = 'collection-track-scroll'; area.dataset.collectionScroll = 'songs';
  for (let i = 0; i < 2000; i++) {
    const row = document.createElement('div'); row.className = 'collection-track-row'; row.dataset.collectionAnchor = `${i}`;
    const y = i === 0 ? 6 : i === 1 ? 12 : 18;
    row.style.transform = `matrix(1, 0, 0, 1, 0, ${y})`;
    row.getBoundingClientRect = () => ({ top: 106 + i * 44 + y, bottom: 150 + i * 44 + y, height: 44, width: 1084 });
    area.append(row);
  }
  root.append(area); host.replaceChildren(root);
  const snapshot = snapshotSurface(root);
  const frozen = snapshot.node.querySelector('.collection-track-scroll');
  assert.equal(frozen.querySelectorAll('.collection-track-row').length, 16, 'item transforms cannot change the visible range');
  assert.equal(frozen.lastElementChild.style.height, `${(2000 - 16) * 44}px`, 'the frozen list preserves its static scroll extent');
  assert.equal(frozen.firstElementChild.style.transform, 'matrix(1, 0, 0, 1, 0, 6)', 'the actual visible item frame is still retained');
  snapshot.layer.remove();
});

test("a quick page return resumes frozen covers and never hides already settled items", t => {
  const { document, motion, animations, mount } = setup(t);
  const rows = () => {
    const page = mount('content-band collection-connected');
    page.innerHTML = '<div class="collection-content"><div class="collection-album-index" data-collection-scroll="albums"></div></div>';
    const area = page.querySelector('.collection-album-index');
    for (let i = 0; i < 80; i++) {
      const row = document.createElement('div'); row.dataset.collectionAnchor = `${i}`;
      row.getBoundingClientRect = () => ({ top: 106 + i * 44, bottom: 150 + i * 44, height: 44 });
      area.append(row);
    }
    return area;
  };
  motion.prepare('quickplay', 'collection', resolvePageTransition('quickplay', 'collection'), true);
  const area = rows(); motion.enter();
  area.firstElementChild.style.transform = 'matrix(1, 0, 0, 1, 0, 7)';
  area.firstElementChild.style.opacity = '0.5';
  area.children[1].style.opacity = '1';
  motion.prepare('collection', 'quickplay', resolvePageTransition('collection', 'quickplay'), true);
  mount('quickplay'); motion.enter();
  motion.prepare('quickplay', 'collection', resolvePageTransition('quickplay', 'collection'), true);
  const returning = rows(); motion.enter();
  const returned = animations.filter(a => a.node.parentElement === returning && !a.cancelled);
  assert.equal(returned[0].frames[0].opacity, '0.5');
  assert.equal(returned[1].frames[0].opacity, '1', 'fully visible rows stay visible on reversal');
  assert.ok(returned.every(a => a.frames.every(frame => frame.transform === undefined)));
  assert.ok(returned.every(a => a.options.delay === 0));
  returned.forEach(a => a.finish());
  animations.filter(a => !a.cancelled).forEach(a => a.finish());
  assert.equal(returning.style.overflowAnchor, '', 'natural completion restores anchoring');
  motion.stop();
});

test("entering the collection on a playlist scopes page movement to its right pane", t => {
  const { document, motion, animations, mount } = setup(t);
  motion.prepare('quickplay', 'collection', resolvePageTransition('quickplay', 'collection'), true);
  const page = mount('content-band collection-connected');
  page.innerHTML = '<div class="collection-toolbar">分类</div><div class="collection-content"><div class="playlist-browser"><section class="playlist-list"><div class="playlist-create">新建</div><button data-collection-anchor="favorites">喜欢的歌曲</button></section><section class="playlist-content"><header class="playlist-heading">喜欢的歌曲</header><section class="collection-track-list"><div class="collection-track-head">表头</div><div class="collection-track-scroll" data-collection-scroll="songs"></div></section></section></div></div>';
  const right = page.querySelector('.playlist-content'), area = page.querySelector('.collection-track-scroll');
  for (let i = 0; i < 10; i++) {
    const row = document.createElement('div'); row.className = 'collection-track-row'; row.dataset.collectionAnchor = `${i}`;
    row.getBoundingClientRect = () => ({ top: 106 + i * 44, bottom: 150 + i * 44, height: 44 }); area.append(row);
  }
  motion.enter();
  const incoming = animations.filter(a => page.contains(a.node));
  assert.equal(incoming.length, 2);
  assert.ok(incoming.every(a => right.contains(a.node)), 'root, toolbar, sidebar and shared parents all remain still');
  assert.equal(incoming.filter(a => a.node === right).length, 2, 'one shared region owns both movement and alpha');
  assert.equal(incoming.filter(a => a.frames[0].transform !== undefined).length, 1);
  assert.equal(incoming.filter(a => a.frames[0].opacity !== undefined).length, 1);
  assert.match(document.querySelector('.motion-departure').style.clipPath, /^inset\(/, 'old full-width pixels are clipped to the right pane');
  motion.stop();
});

test("settling an unfinished collection entrance never moves the navigation", t => {
  const { document, motion, animations, mount } = setup(t);
  motion.prepare('quickplay', 'collection', resolvePageTransition('quickplay', 'collection'), true);
  const page = mount('content-band collection-connected');
  page.innerHTML = '<div class="collection-toolbar">分类</div><div class="collection-content"><ul class="collection-artist-index"><li>艺术家</li></ul></div>';
  const content = page.querySelector('.collection-content');
  motion.enter();
  const list = content.querySelector('ul');
  list.style.transform = 'matrix(1, 0, 0, 1, 12, 0)'; list.style.opacity = '0.5';
  motion.settle();
  const settling = animations.filter(a => !a.cancelled && page.contains(a.node));
  assert.ok(settling.every(a => content.contains(a.node)));
  const transport = settling.find(a => a.node === list);
  assert.equal(transport.frames[0].transform, list.style.transform, 'the content settles from its visible frame');
  assert.equal(transport.frames[0].opacity, '0.5');
  assert.equal(animations.filter(a => a.node === page || a.node === page.querySelector('.collection-toolbar')).length, 0);
  motion.stop();
  assert.ok(animations.every(a => a.cancelled));
  assert.equal(document.querySelector('.motion-departure'), null);
});

test("a playlist page return combines departing parent and right-pane frames", t => {
  const { document, motion, animations, mount } = setup(t);
  const playlist = () => {
    const root = mount('content-band collection-connected');
    root.innerHTML = '<div class="collection-content"><div class="playlist-list">索引</div><div class="playlist-content">歌曲</div></div>';
    return root;
  };
  playlist();
  motion.prepare('collection', 'quickplay', resolvePageTransition('collection', 'quickplay'), true);
  const old = document.querySelector('.motion-departure > .collection-content');
  old.style.transform = 'matrix(1, 0, 0, 1, -18, 0)'; old.style.opacity = '0.6';
  old.querySelector('.playlist-content').style.transform = 'matrix(1, 0, 0, 1, 24, 2)';
  old.querySelector('.playlist-content').style.opacity = '0.8';
  mount('quickplay'); motion.enter();
  motion.prepare('quickplay', 'collection', resolvePageTransition('quickplay', 'collection'), true);
  const returned = playlist(); motion.enter();
  const pane = returned.querySelector('.playlist-content');
  const arrivals = animations.filter(a => a.node === pane && !a.cancelled);
  assert.equal(arrivals[0].frames[0].transform, 'translate3d(6px,2px,0)', 'the parent departure offset is retained without moving the sidebar');
  assert.equal(arrivals[1].frames[0].opacity, '0.48', 'the visible inherited opacity is retained');
  assert.ok(animations.filter(a => returned.contains(a.node) && !a.cancelled).every(a => pane.contains(a.node)));
  motion.stop();
});
