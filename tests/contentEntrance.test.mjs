import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { captureContentFrames, contentEntranceItems, playContentEntrance, suspendContentAnchoring } from "../.tmp/visualizer-tests/motion/contentEntrance.js";
import { BROWSE_MOTION as motion } from "../.tmp/visualizer-tests/motion/tokens.js";

const rect = (top, height, left = 0, width = 900) => ({ top, bottom: top + height, left, right: left + width, width, height });
function setup(t) {
  const dom = new JSDOM('<body><section class="collection-content"><div class="collection-track-list" data-collection-list="songs"><div class="collection-track-scroll" data-collection-scroll="tracks:songs"></div></div></section></body>');
  t.after(() => dom.window.close());
  const root = dom.window.document.querySelector('section'), list = root.querySelector('.collection-track-scroll');
  root.getBoundingClientRect = list.getBoundingClientRect = () => rect(100, 500);
  return { dom, root, list };
}

test("restored long lists build in only visible rows, with constant layout reads and capped delay", t => {
  const { dom, root, list } = setup(t);
  list.scrollTop = 4400;
  let reads = 0;
  for (let i = 0; i < 2000; i++) {
    const row = dom.window.document.createElement('div');
    row.className = 'collection-track-row'; row.dataset.collectionAnchor = `track-${i}`;
    row.getBoundingClientRect = () => { reads++; return rect(100 + i * 44 - list.scrollTop, 44); };
    list.append(row);
  }
  const items = contentEntranceItems(root);
  assert.equal(reads, 2);
  assert.equal(items[0].node.dataset.collectionAnchor, 'track-100');
  assert.equal(items.length, 12);
  assert.equal(items[0].delay, 0);
  assert.equal(items[1].delay - items[0].delay, motion.stagger);
  assert.equal(Math.max(...items.map(item => item.delay)), 0 + motion.maxDelay);
  const animations = [];
  playContentEntrance(items, (node, frames, duration, delay) => animations.push({ node, frames, duration, delay }));
  assert.equal(animations.length, items.length);
  assert.ok(animations.every(a => !a.frames[0].transform?.includes('scale')));
  assert.ok(animations.every(a => a.frames.every(frame => frame.transform === undefined)), 'rows keep their baselines while the table owns movement');
  assert.equal(animations[0].duration, motion.itemFade);
  assert.ok(animations.every(a => Number(a.frames[0].opacity) > 0), 'staggered rows stay faintly readable instead of appearing from black');
  assert.equal(list.scrollTop, 4400);
  assert.equal(list.children.length, 2000);
  list.style.overflowAnchor = 'auto';
  const restore = suspendContentAnchoring(items);
  assert.equal(list.style.overflowAnchor, 'none', 'the browser cannot reinterpret item motion as scroll displacement');
  restore();
  assert.equal(list.style.overflowAnchor, 'auto', 'disposal preserves the previous style');
});

test("regular cover and artist grids reveal the restored visible band in reading order", t => {
  const { dom, root, list } = setup(t);
  list.className = 'collection-album-index';
  list.style.display = 'grid'; list.style.gridTemplateColumns = '160px 160px 160px';
  let reads = 0;
  for (let i = 0; i < 1200; i++) {
    const item = dom.window.document.createElement('div'); item.dataset.collectionAnchor = `album-${i}`;
    item.getBoundingClientRect = () => { reads++; return rect(100 + Math.floor(i / 3) * 220 - 6600, 200, (i % 3) * 180, 160); };
    list.append(item);
  }
  const items = contentEntranceItems(root);
  assert.equal(reads, 2);
  assert.deepEqual(items.map(item => item.node.dataset.collectionAnchor), Array.from({ length: 9 }, (_, i) => `album-${90 + i}`));
  assert.ok(items.slice(1).every((item, i) => item.delay >= items[i].delay));
  list.getBoundingClientRect = () => rect(800, 500);
  assert.equal(contentEntranceItems(root).length, 0, 'offscreen sections create no item animations');
});

test("content work has a total cap and a rapid return resumes frozen item frames without hiding settled items", t => {
  const { dom, root, list } = setup(t);
  for (let i = 0; i < 500; i++) {
    const row = dom.window.document.createElement('div'); row.className = 'collection-track-row'; row.dataset.collectionAnchor = `track-${i}`;
    row.getBoundingClientRect = () => rect(100 + i * 2, 2);
    list.append(row);
  }
  const items = contentEntranceItems(root);
  assert.equal(items.length, motion.maxItems);
  items[0].node.style.transform = 'matrix(1, 0, 0, 1, 0, 9)'; items[0].node.style.opacity = '0.45';
  const saved = captureContentFrames(root), animations = [];
  playContentEntrance(items, (node, frames, duration, delay) => animations.push({ node, frames, duration, delay }), saved);
  assert.equal(animations[0].frames[0].opacity, '0.45');
  assert.equal(animations[1].frames[0].opacity, '1', 'settled rows never restart at transparent');
  assert.ok(animations.every(a => a.frames.every(frame => frame.transform === undefined)));
  assert.ok(animations.every(a => a.delay === 0));
});

test("a restored grid starts after a fully clipped row even when the viewport falls inside its gap", t => {
  const { dom, root, list } = setup(t);
  list.className = 'collection-artist-index';
  list.style.display = 'grid'; list.style.gridTemplateColumns = '240px 240px';
  for (let i = 0; i < 40; i++) {
    const item = dom.window.document.createElement('li'); item.dataset.collectionAnchor = `artist-${i}`;
    item.getBoundingClientRect = () => rect(10 + Math.floor(i / 2) * 96, 88);
    list.append(item);
  }
  const items = contentEntranceItems(root);
  assert.equal(items[0].node.dataset.collectionAnchor, 'artist-2');
  assert.equal(items[0].delay, 0, 'hidden items consume no stagger time');
  assert.ok(items.every(({ node }) => node.getBoundingClientRect().bottom > 100));
});

test("overlapping page and panel arrivals keep anchoring suspended until the last owner releases it", t => {
  const { dom, list } = setup(t);
  const row = dom.window.document.createElement('div'); list.append(row);
  list.style.overflowAnchor = 'auto';
  const items = [{ node: row, key: 'song', delay: 0 }];
  const releasePage = suspendContentAnchoring(items), releasePanel = suspendContentAnchoring(items);
  releasePage(); releasePage();
  assert.equal(list.style.overflowAnchor, 'none', 'an earlier controller cannot restore anchoring during the later arrival');
  releasePanel(); releasePanel();
  assert.equal(list.style.overflowAnchor, 'auto', 'the original style is restored once, after all controllers finish');
});

test("playlist navigation is never selected for item entrances", t => {
  const { root, list, dom } = setup(t);
  const sidebar = dom.window.document.createElement('section'); sidebar.className = 'playlist-list';
  sidebar.innerHTML = '<div class="playlist-create">新建播放列表</div><button data-collection-anchor="favorites">喜欢的歌曲</button>';
  sidebar.getBoundingClientRect = () => { throw new Error('navigation is outside the data reveal'); };
  root.prepend(sidebar);
  for (let i = 0; i < 10; i++) {
    const row = dom.window.document.createElement('div'); row.className = 'collection-track-row'; row.dataset.collectionAnchor = `${i}`;
    row.getBoundingClientRect = () => rect(100 + i * 44, 44); list.append(row);
  }
  const items = contentEntranceItems(root);
  assert.equal(items.length, 10);
  assert.ok(items.every(({ node }) => node.parentElement === list));
});
