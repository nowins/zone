import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { playBrowseTransition, prepareBrowseTransition, captureBrowseFrames } from '../.tmp/visualizer-tests/motion/browseTransition.js';
import { playCollectionPivot } from '../.tmp/visualizer-tests/motion/collectionPivot.js';
import { BROWSE_MOTION, MOTION_EASINGS } from '../.tmp/visualizer-tests/motion/tokens.js';

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

test('mixed cover sections reveal their headings without fading a cover ancestor', t => {
  const { animations, mount } = setup(t);
  const page = mount('<section class="podcast-page"><main class="podcast-screen"><section class="podcast-content-section"><div class="podcast-section-title"><h2>已关注</h2></div><div class="podcast-library-sorts">排序</div><div class="podcast-library-grid"><article class="podcast-library-show" data-podcast-show="one">节目一</article></div></section></main></section>');
  const stop = playBrowseTransition(page, 1);
  const title = page.querySelector('.podcast-section-title'), grid = page.querySelector('.podcast-library-grid');
  assert.equal(animations.find(a => a.node === title).frames[0].opacity, 0);
  assert.equal(animations.filter(a => a.node === grid).length, 0, 'card containers cannot multiply their child alpha');
  assert.ok(animations.filter(a => a.node === title).every(a => a.frames.every(frame => frame.transform === undefined)), 'title inherits the single region translation');
  title.style.opacity = '0.42';
  prepareBrowseTransition(page, 'library', 'discover', 1);
  prepareBrowseTransition(page, 'discover', 'library', -1);
  title.style.opacity = '';
  const back = playBrowseTransition(page, -1);
  assert.equal(animations.findLast(a => !a.cancelled && a.node === title).frames[0].opacity, '0.42', 'reversal keeps the heading alpha as well as the covers');
  back(); stop();
});

test('quickplay uses one content transport, reading-order covers, and fixed depth planes', t => {
  const { animations, mount } = setup(t);
  const page = mount('<section class="quickplay"><div class="quickplay-ghost">quickplay</div><div class="quickplay-backdrop"></div><div class="quickplay-viewport"><article class="quick-group"><h2>固定</h2><div class="pin-grid"><article class="quick-pin" data-pin-id="one">封面一</article><article class="quick-pin" data-pin-id="two">封面二</article></div></article></div></section>');
  const stop = playBrowseTransition(page, -1);
  const group = page.querySelector('.quick-group');
  assert.ok(animations.every(a => group.contains(a.node)), 'root, viewport, giant title and backdrop remain stable');
  assert.equal(animations.filter(a => a.frames[0].transform !== undefined).length, 1, 'no root + group double translation');
  assert.equal(animations[0].frames[0].transform, `translate3d(${BROWSE_MOTION.drift}px,0,0)`);
  assert.deepEqual(animations.filter(a => a.node.matches('.quick-pin')).map(a => a.options.delay), [0, BROWSE_MOTION.stagger]);
  assert.equal(animations.find(a => a.node.matches('h2')).options.duration, BROWSE_MOTION.reveal);
  stop();
});

test('heading frame capture never expands into computed-style reads across song rows', t => {
  const { window, mount } = setup(t);
  const page = mount('<section class="collection-connected"><div class="collection-content"><section class="collection-track-list"><div class="collection-track-head">表头</div><div class="collection-track-scroll"></div></section></div></section>');
  const scroll = page.querySelector('.collection-track-scroll');
  scroll.innerHTML = Array.from({length: 2000}, () => '<div class="collection-track-row">歌曲</div>').join('');
  let rowReads = 0;
  const read = window.getComputedStyle.bind(window);
  window.getComputedStyle = node => { if (node.matches('.collection-track-row')) rowReads++; return read(node); };
  captureBrowseFrames(page.querySelector('.collection-content'));
  assert.equal(rowReads, 0, 'only cover regions contain separately animated heading alpha');
});

test('collection categories and podcast sections use one controller with stationary chrome', t => {
  assert.equal(playCollectionPivot, playBrowseTransition, 'collection cannot drift into a separate implementation');
  const { animations, mount } = setup(t);
  for (const group of ['collection-artist-index', 'collection-album-index', 'collection-track-list']) {
    const page = mount(`<section class="collection-connected"><header class="collection-toolbar"><button>分类</button><input></header><p>数量</p><div class="collection-content"><div class="${group}">内容</div></div></section>`);
    const stop = playBrowseTransition(page, 1);
    const active = animations.filter(a => !a.cancelled);
    assert.equal(active.length, 2);
    assert.equal(active[0].node.className, group);
    assert.equal(active[0].frames[0].transform, `translate3d(-${BROWSE_MOTION.drift}px,0,0)`, 'forward content approaches from the left');
    assert.equal(active[0].options.duration, BROWSE_MOTION.duration);
    assert.equal(active[1].options.duration, BROWSE_MOTION.reveal);
    stop();
  }
  const podcast = mount('<section class="podcast-page"><header class="podcast-header"><nav>分区</nav><input></header><main class="podcast-screen"><section class="podcast-content-section">节目</section><section class="podcast-content-section">单集</section></main></section>');
  const stop = playBrowseTransition(podcast, -1);
  const active = animations.filter(a => !a.cancelled);
  assert.equal(active.length, 4);
  assert.ok(active.every(a => a.node.className === 'podcast-content-section'));
  assert.ok(active.filter(a => a.frames[0].transform).every(a => a.frames[0].transform === `translate3d(${BROWSE_MOTION.drift}px,0,0)`));
  assert.ok(active.every(a => a.options.duration === (a.frames[0].transform ? BROWSE_MOTION.duration : BROWSE_MOTION.reveal)));
  assert.ok(active.every(a => a.options.delay === 0), 'text regions enter together');
  stop();
  for (const markup of [
    '<section class="podcast-show-hero">节目身份</section><section class="podcast-show-episodes">单集</section>',
    '<article class="podcast-detail">单集详情</article><section class="podcast-content-section">相关单集</section>',
  ]) {
    const detail = mount(`<section class="podcast-page"><header class="podcast-header">返回</header><main class="podcast-screen">${markup}</main></section>`);
    const release = playBrowseTransition(detail, 1);
    const current = animations.filter(a => !a.cancelled);
    assert.equal(current.length, 4, 'identity and related content have separate movement and reveal durations');
    assert.ok(current.every(a => a.node.parentElement.matches('.podcast-screen')));
    assert.ok(current.every(a => a.options.duration === (a.frames[0].transform ? BROWSE_MOTION.duration : BROWSE_MOTION.reveal)));
    release();
  }
});

test('podcast text-list reversal keeps the region frame and scroll without row animation', t => {
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
  assert.equal(rows.length, 0, 'all episode rows appear as a coherent text region');
  section.style.opacity = '0.55'; section.style.transform = 'matrix(1,0,0,1,-9,0)';
  prepareBrowseTransition(page, 'listen', 'discover', 1);
  const ghost = document.querySelector('.motion-departure');
  const exit = animations.at(-1);
  assert.equal(exit.options.duration, BROWSE_MOTION.exit);
  assert.equal(exit.frames[0].transform, exit.frames[1].transform, 'old text clears without another slide');
  assert.ok(ghost.classList.contains('podcast-page'), 'the copied content retains podcast layout context');
  assert.equal(ghost.firstElementChild.scrollTop, 800, 'the main scroller itself is restored');
  prepareBrowseTransition(page, 'discover', 'listen', -1);
  assert.equal(document.querySelectorAll('.motion-departure').length, 1);
  addRows();
  section.children[10].textContent = '单集 10 · 已播放 0:31';
  const returned = playBrowseTransition(page, -1);
  const visible = animations.filter(a => a.node.matches('.podcast-episode') && !a.cancelled);
  assert.equal(visible.length, 0, 'progress text cannot restart individual rows');
  const current = animations.filter(a => a.node === section && !a.cancelled);
  assert.equal(current[0].frames[0].transform, 'translate3d(-9px,0px,0)');
  assert.equal(current[1].frames[0].opacity, '0.55');
  assert.ok(current.every(a => a.options.delay === 0));
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
  assert.equal(current.length, 2);
  assert.equal(current[0].frames[0].transform, 'translate3d(7px,0px,0)');
  assert.equal(current[1].frames[0].opacity, '0.7');
  assert.ok(animations.filter(a => !a.cancelled && page.contains(a.node)).every(a => a.node === panel));
  back(); first();
  assert.equal(document.querySelector('.motion-departure'), null);
});

test('cover regions own only translation; reading-order alpha is never multiplied by an ancestor fade', t => {
  const { animations, mount } = setup(t);
  for (const library of ['collection', 'podcast', 'podcast-library']) {
    const page = library === 'collection'
      ? mount('<section class="collection-connected"><div class="collection-content"><div class="collection-album-index"><div data-collection-anchor="one">封面一</div><div data-collection-anchor="two">封面二</div></div></div></section>')
      : mount(`<section class="podcast-page"><main class="podcast-screen"><section class="podcast-content-section"><article class="${library === 'podcast' ? 'podcast-show-card' : 'podcast-library-show'}" data-podcast-show="one">节目一</article><article class="${library === 'podcast' ? 'podcast-show-card' : 'podcast-library-show'}" data-podcast-show="two">节目二</article></section></main></section>`);
    const group = page.querySelector('.collection-album-index,.podcast-content-section');
    group.children[1].getBoundingClientRect = () => ({ left: 50, right: 950, top: 130, bottom: 210, width: 900, height: 80 });
    const stop = playBrowseTransition(page, 1);
    const current = animations.filter(a => !a.cancelled);
    const transport = current.filter(a => a.node === group);
    assert.equal(transport.length, 1);
    assert.ok(transport[0].frames.every(frame => frame.opacity === undefined));
    const cards = current.filter(a => a.node.parentElement === group);
    assert.equal(cards.length, 2);
    assert.deepEqual(cards.map(a => a.options.delay), [0, BROWSE_MOTION.stagger]);
    assert.ok(cards.every(a => a.frames[0].opacity === '0' && a.options.duration === BROWSE_MOTION.reveal));
    assert.equal(transport[0].options.easing, `cubic-bezier(${MOTION_EASINGS.browse.join(',')})`);
    assert.ok(cards.every(a => a.options.easing === `cubic-bezier(${MOTION_EASINGS.dissolve.join(',')})`), 'alpha builds gradually rather than inheriting the steep transport curve');
    cards.forEach(a => a.finish());
    assert.equal(transport[0].cancelled, false, 'finished reveals leave the slower movement running');
    stop();
  }
});

test('persistent controls do not accelerate the arrival and old pixels cannot cover the playlist index', t => {
  const { animations, window, document, mount } = setup(t);
  const page = mount('<section class="collection-connected"><header><button>分类</button><input></header><div class="collection-content"><aside class="playlist-list"><button>喜欢的歌曲</button></aside><section class="playlist-content"><button>播放</button></section></div></section>');
  const pane = page.querySelector('.playlist-content');
  pane.getBoundingClientRect = () => ({ left: 350, right: 950, top: 50, bottom: 450, width: 600, height: 400 });
  const ghost = document.createElement('div'); ghost.className = 'motion-departure'; document.body.append(ghost);
  const stop = playBrowseTransition(page, 1);
  assert.equal(ghost.style.clipPath, 'inset(0px 0px 0px 300px)');
  const original = [...animations];
  page.querySelector('header button').dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  page.querySelector('input').dispatchEvent(new window.Event('keydown', { bubbles: true }));
  page.querySelector('.playlist-list button').dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(animations.length, original.length);
  assert.ok(original.every(a => !a.cancelled));
  pane.querySelector('button').dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.ok(original.every(a => a.cancelled), 'input in moving content can take over immediately');
  assert.equal(animations.filter(a => !a.cancelled).length, 1, 'one current-frame settle per moving region');
  stop();
});

test('podcast cover reversal resumes stable media identity when title text changes', t => {
  const { animations, mount } = setup(t);
  const page = mount('<section class="podcast-page"><main class="podcast-screen"><section class="podcast-content-section"><article class="podcast-show-card" data-podcast-show="one">旧标题</article></section></main></section>');
  const first = playBrowseTransition(page, 1), card = page.querySelector('article');
  card.style.opacity = '0.45';
  prepareBrowseTransition(page, 'library', 'discover', 1);
  prepareBrowseTransition(page, 'discover', 'library', -1);
  card.style.opacity = ''; card.textContent = '新标题';
  const back = playBrowseTransition(page, -1);
  const reveal = animations.findLast(a => !a.cancelled && a.node === card);
  assert.equal(reveal.frames[0].opacity, '0.45');
  assert.equal(reveal.options.delay, 0, 'a return never repeats the initial sequence');
  back(); first();
});

test('podcast local episode results enter as one group while search and filters stay stationary', t => {
  const { animations, mount } = setup(t);
  const page = mount('<section class="podcast-page"><main class="podcast-screen"><nav>标签</nav><div class="podcast-tab-content"><div class="podcast-episode-browser"><div class="podcast-episode-filters"><input><button>筛选</button></div><section class="podcast-episode-results"><article class="podcast-episode">单集</article></section></div></div></main></section>');
  const results = page.querySelector('.podcast-episode-results');
  const stop = playBrowseTransition(page.querySelector('.podcast-tab-content'), 1);
  assert.equal(animations.length, 2);
  assert.ok(animations.every(a => a.node === results));
  assert.equal(animations[0].frames[0].transform, `translate3d(-${BROWSE_MOTION.drift}px,0,0)`);
  stop();
});
