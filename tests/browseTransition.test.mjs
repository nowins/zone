import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { playBrowseTransition, prepareBrowseTransition } from '../.tmp/visualizer-tests/motion/browseTransition.js';
import { playCollectionPivot } from '../.tmp/visualizer-tests/motion/collectionPivot.js';
import { BROWSE_MOTION } from '../.tmp/visualizer-tests/motion/tokens.js';

function setup(t) {
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window, animations = [];
  window.matchMedia = () => ({ matches: false });
  window.DOMMatrixReadOnly = class {
    constructor(value) {
      const numbers = value?.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      this.m41 = value?.startsWith('matrix(') ? numbers[4] : numbers[1] ?? 0;
      this.m42 = value?.startsWith('matrix(') ? numbers[5] : numbers[2] ?? 0;
    }
  };
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 50, right: 950, top: 50, bottom: 450, width: 900, height: 400 });
  window.HTMLElement.prototype.getAnimations = function(options) {
    return animations.filter(a => !a.cancelled && (a.node === this || options?.subtree && this.contains(a.node)));
  };
  window.HTMLElement.prototype.animate = function(frames, options) {
    const animation = { node: this, effect: { target: this }, frames, options, cancelled: false, playState: 'running', onfinish: null,
      cancel() { this.cancelled = true; this.playState = 'idle'; },
      finish() { this.playState = 'finished'; this.onfinish?.(); } };
    animations.push(animation); return animation;
  };
  const mount = markup => { document.body.innerHTML = markup; return document.body.firstElementChild; };
  return { window, document, animations, mount };
}

test('collection categories and podcast sections use one controller with stationary chrome', t => {
  assert.equal(playCollectionPivot, playBrowseTransition, 'collection cannot drift into a separate implementation');
  const { animations, mount } = setup(t);
  for (const group of ['collection-artist-index', 'collection-album-index', 'collection-track-list']) {
    const page = mount(`<section class="collection-connected"><header class="collection-toolbar"><button>分类</button><input></header><p>数量</p><div class="collection-content"><div class="${group}">内容</div></div></section>`);
    const stop = playBrowseTransition(page, 1);
    const active = animations.filter(a => !a.cancelled);
    assert.equal(active.length, 1);
    assert.equal(active[0].node.className, group);
    assert.equal(active[0].frames[0].transform, `translate3d(${BROWSE_MOTION.drift}px,0,0)`);
    assert.equal(active[0].options.duration, BROWSE_MOTION.duration);
    stop();
  }
  const podcast = mount('<section class="podcast-page"><header class="podcast-header"><nav>分区</nav><input></header><main class="podcast-screen"><section class="podcast-content-section">节目</section><section class="podcast-content-section">单集</section></main></section>');
  const stop = playBrowseTransition(podcast, -1);
  const active = animations.filter(a => !a.cancelled);
  assert.equal(active.length, 2);
  assert.ok(active.every(a => a.node.className === 'podcast-content-section'));
  assert.ok(active.every(a => a.frames[0].transform === `translate3d(-${BROWSE_MOTION.drift}px,0,0)`));
  assert.ok(active.every(a => a.options.duration === BROWSE_MOTION.duration));
  assert.equal(active[1].options.delay, BROWSE_MOTION.stagger);
  stop();
  for (const markup of [
    '<section class="podcast-show-hero">节目身份</section><section class="podcast-show-episodes">单集</section>',
    '<article class="podcast-detail">单集详情</article><section class="podcast-content-section">相关单集</section>',
  ]) {
    const detail = mount(`<section class="podcast-page"><header class="podcast-header">返回</header><main class="podcast-screen">${markup}</main></section>`);
    const release = playBrowseTransition(detail, 1);
    const current = animations.filter(a => !a.cancelled);
    assert.equal(current.length, 2, 'identity and related content both take part in the shared transition');
    assert.ok(current.every(a => a.node.parentElement.matches('.podcast-screen')));
    assert.ok(current.every(a => a.options.duration === BROWSE_MOTION.duration));
    release();
  }
});

test('podcast reversal keeps scroll and stable episode frames while progress text changes', t => {
  const { document, animations, mount } = setup(t);
  const page = mount('<section class="podcast-page"><header class="podcast-header">导航</header><main class="podcast-screen"><section class="podcast-content-section"></section></main></section>');
  const screen = page.querySelector('main'), section = screen.firstElementChild;
  screen.scrollTop = 800;
  const addRows = () => {
    section.innerHTML = '';
    for (let i = 0; i < 40; i++) {
      const row = document.createElement('article'); row.className = 'podcast-episode'; row.dataset.podcastEpisode = `episode-${i}`;
      row.textContent = `单集 ${i} · 已播放 0:30`;
      row.getBoundingClientRect = () => ({ left: 50, right: 950, top: 50 + i * 80 - screen.scrollTop, bottom: 130 + i * 80 - screen.scrollTop, width: 900, height: 80 });
      section.append(row);
    }
  };
  addRows();
  const stop = playBrowseTransition(page, 1);
  const rows = animations.filter(a => a.node.matches('.podcast-episode') && !a.cancelled);
  assert.deepEqual(rows.map(a => a.node.dataset.podcastEpisode), ['episode-10', 'episode-11', 'episode-12', 'episode-13', 'episode-14']);
  assert.ok(rows.every(a => a.frames.every(frame => frame.transform === undefined)), 'row baselines never move');
  rows[0].node.style.opacity = '0.55';
  prepareBrowseTransition(page, 'listen', 'discover', 1);
  const ghost = document.querySelector('.motion-departure');
  assert.ok(ghost.classList.contains('podcast-page'), 'the copied content retains podcast layout context');
  assert.equal(ghost.firstElementChild.scrollTop, 800, 'the main scroller itself is restored');
  prepareBrowseTransition(page, 'discover', 'listen', -1);
  assert.equal(document.querySelectorAll('.motion-departure').length, 1);
  addRows();
  section.children[10].textContent = '单集 10 · 已播放 0:31';
  const returned = playBrowseTransition(page, -1);
  const visible = animations.filter(a => a.node.matches('.podcast-episode') && !a.cancelled);
  assert.equal(visible[0].frames[0].opacity, '0.55', 'progress text cannot invalidate episode identity');
  assert.equal(visible[1].frames[0].opacity, '1', 'settled rows stay visible');
  assert.ok(visible.every(a => a.options.delay === 0));
  returned(); stop();
  assert.equal(screen.style.overflowAnchor, '');
  assert.equal(document.querySelector('.motion-departure'), null);
});

test('panel takeover cancels page arrivals, leaves tabs static, and releases motion on hide or reduced motion', t => {
  const { window, document, animations, mount } = setup(t);
  const page = mount('<section class="podcast-page"><header>导航</header><main class="podcast-screen"><div class="podcast-library-tabs"><button>标签</button></div><div class="podcast-tab-content"><section class="podcast-content-section">内容</section></div></main></section>');
  const pageStop = playBrowseTransition(page, 1), original = animations.filter(a => !a.cancelled);
  const panel = page.querySelector('.podcast-tab-content');
  const panelStop = playBrowseTransition(panel, -1);
  assert.ok(original.every(a => a.cancelled), 'one owner controls a browsing page at a time');
  assert.ok(animations.filter(a => !a.cancelled).every(a => panel.contains(a.node)));
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.ok(animations.every(a => a.cancelled));
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  window.matchMedia = () => ({ matches: true });
  const count = animations.length;
  playBrowseTransition(page, 1)();
  prepareBrowseTransition(page, 'library', 'playlist', 1);
  assert.equal(animations.length, count);
  assert.equal(document.querySelector('.motion-departure'), null);
  panelStop(); pageStop();
});

test('a podcast panel without semantic sections resumes its departure frame on reversal', t => {
  const { document, animations, mount } = setup(t);
  const page = mount('<section class="podcast-page"><header>分区</header><main class="podcast-screen"><nav>标签</nav><div class="podcast-tab-content">暂无列表</div></main></section>');
  const panel = page.querySelector('.podcast-tab-content');
  const first = playBrowseTransition(page, 1);
  panel.style.transform = 'matrix(1,0,0,1,7,0)'; panel.style.opacity = '0.7';
  prepareBrowseTransition(page, 'playlist', 'listen', -1);
  prepareBrowseTransition(page, 'listen', 'playlist', 1);
  const back = playBrowseTransition(page, 1);
  const current = animations.filter(a => !a.cancelled && a.node === panel);
  assert.equal(current.length, 1);
  assert.equal(current[0].frames[0].transform, 'translate3d(7px,0px,0)');
  assert.equal(current[0].frames[0].opacity, '0.7');
  assert.ok(animations.filter(a => !a.cancelled && page.contains(a.node)).every(a => a.node === panel));
  back(); first();
  assert.equal(document.querySelector('.motion-departure'), null);
});
