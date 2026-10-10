import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { installTouchInteractions } from "../.tmp/visualizer-tests/utils/touchInteractions.js";
import { TILE_MOTION } from "../.tmp/visualizer-tests/motion/tokens.js";

function setup(t) {
  const dom = new JSDOM('<div id="root"><div id="scroll"><div data-touch-menu id="row"><button id="play">播放</button><div class="collection-track-actions"><button id="favorite">喜欢</button></div></div><div class="quick-pin"><button id="pin">固定</button></div></div><button id="other">其他</button></div>');
  const { window: view } = dom;
  const doc = view.document, root = doc.getElementById('root'), play = doc.getElementById('play');
  const calls = {play:0, favorite:0, other:0, contexts:[]};
  for(const id of ['play','favorite','other']) doc.getElementById(id).addEventListener('click',()=>calls[id]++);
  doc.getElementById('row').addEventListener('contextmenu',event=>{
    event.preventDefault(); calls.contexts.push({target:event.target.id,x:event.clientX,y:event.clientY});
  });
  let now=0, timerId=0;
  const timers = new Map();
  view.setTimeout=(fn,delay)=>{timers.set(++timerId,{fn,at:now+delay});return timerId;};
  view.clearTimeout=id=>timers.delete(id);
  Object.defineProperty(view.performance,'now',{value:()=>now});
  const advance=ms=>{now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}};
  const close = installTouchInteractions(root);
  t.after(()=>{close();dom.window.close();});
  function pointer(target,type,extra={}) {
    const event=new view.MouseEvent(type,{bubbles:true,cancelable:true,clientX:30,clientY:40,button:0,...extra});
    Object.defineProperties(event,{pointerId:{value:extra.id??1},pointerType:{value:extra.pointerType??'touch'},isPrimary:{value:extra.primary??true}});
    target.dispatchEvent(event);return event;
  }
  function click(target=play,detail=1,type='click') {
    const event=new view.MouseEvent(type,{bubbles:true,cancelable:true,detail});target.dispatchEvent(event);return event;
  }
  return {view,doc,root,play,calls,advance,timers,close,pointer,click};
}

test('a held media item opens one existing entity menu at the finger and release never activates',t=>{
  const f=setup(t);
  f.pointer(f.play,'pointerdown');f.advance(TILE_MOTION.longPress-1);
  assert.equal(f.calls.contexts.length,0);
  f.advance(1);
  assert.deepEqual(f.calls.contexts,[{target:'play',x:30,y:40}]);
  f.play.dispatchEvent(new f.view.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  assert.equal(f.calls.contexts.length,1,'native contextmenu cannot duplicate the custom hold');
  f.pointer(f.play,'pointerup');
  assert.equal(f.click(f.play,1,'mousedown').defaultPrevented,true,'compatibility mousedown cannot steal menu focus');
  assert.equal(f.click().defaultPrevented,true);f.click(f.play,2,'dblclick');
  assert.equal(f.calls.play,0);
  f.pointer(f.play,'pointerdown');f.pointer(f.play,'pointerup');f.click();
  assert.equal(f.calls.play,1,'the next intentional tap works');
});

test('native long press wins when it arrives first and compatibility clicks remain suppressed',t=>{
  const f=setup(t);
  f.pointer(f.play,'pointerdown');
  f.play.dispatchEvent(new f.view.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  f.advance(TILE_MOTION.longPress);
  assert.equal(f.calls.contexts.length,1);
  f.pointer(f.play,'pointerup');f.click();
  assert.equal(f.calls.play,0);
});

test('keyboard context menus remain available immediately after a cancelled touch',t=>{
  const f=setup(t);
  f.pointer(f.play,'pointerdown');f.pointer(f.play,'pointercancel');
  f.play.dispatchEvent(new f.view.KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}));
  f.play.dispatchEvent(new f.view.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  assert.equal(f.calls.contexts.length,1);
});

test('Escape during a held touch still suppresses a late release after the compatibility timeout',t=>{
  const f=setup(t);
  f.pointer(f.play,'pointerdown');f.doc.dispatchEvent(new f.view.KeyboardEvent('keydown',{key:'Escape'}));
  f.advance(2000);f.pointer(f.play,'pointerup');f.click();
  assert.equal(f.calls.play,0);assert.equal(f.calls.contexts.length,0);
});

test('movement, cancellation and multi-touch cancel holds and clicks without blocking mouse or keyboard',t=>{
  const f=setup(t);
  for(const cancel of [()=>f.pointer(f.play,'pointermove',{clientX:42}),()=>f.pointer(f.play,'pointercancel'),
    ()=>{f.pointer(f.play,'pointerdown',{id:2,primary:false});f.pointer(f.play,'pointerup',{id:2,primary:false});}]) {
    f.pointer(f.play,'pointerdown');cancel();f.advance(TILE_MOTION.longPress);
    f.pointer(f.play,'pointerup');f.click();
    assert.equal(f.calls.play,0);assert.equal(f.calls.contexts.length,0);
  }
  f.click(f.play,0);assert.equal(f.calls.play,1,'keyboard activation is independent of touch suppression');
  f.pointer(f.play,'pointerdown',{pointerType:'mouse'});f.click();assert.equal(f.calls.play,2);
  f.pointer(f.play,'pointerdown',{pointerType:'pen'});f.click();assert.equal(f.calls.play,3);
});

test('scrolling under a stationary finger and touching moving content cannot activate a row',t=>{
  const f=setup(t), scroll=f.doc.getElementById('scroll');
  f.pointer(f.play,'pointerdown');scroll.dispatchEvent(new f.view.Event('scroll'));f.pointer(f.play,'pointerup');f.click();
  assert.equal(f.calls.play,0);
  f.pointer(f.play,'pointerdown');f.advance(TILE_MOTION.longPress);f.pointer(f.play,'pointerup');f.click();
  assert.equal(f.calls.play,0);assert.equal(f.calls.contexts.length,0,'a stop-scroll tap cannot become a menu hold');
  f.advance(200);f.pointer(f.play,'pointerdown');f.pointer(f.play,'pointerup');f.click();
  assert.equal(f.calls.play,1);
  f.pointer(f.play,'pointerdown');f.doc.getElementById('other').dispatchEvent(new f.view.Event('scroll'));
  f.pointer(f.play,'pointerup');f.click();assert.equal(f.calls.play,2,'unrelated scrolling does not invalidate a tap');
});

test('row actions and pinned tiles keep their own holds, while scroll guards cover every action',t=>{
  const f=setup(t), favorite=f.doc.getElementById('favorite'),pin=f.doc.getElementById('pin');
  for(const target of [favorite,pin]){f.pointer(target,'pointerdown');f.advance(TILE_MOTION.longPress);f.pointer(target,'pointerup');}
  assert.equal(f.calls.contexts.length,0);
  f.pointer(favorite,'pointerdown');favorite.dispatchEvent(new f.view.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  f.pointer(favorite,'pointerup');f.click(favorite);
  assert.equal(f.calls.contexts.length,0,'native touch holds on row actions cannot open the parent menu');
  assert.equal(f.calls.favorite,0);
  f.pointer(favorite,'pointerdown');f.pointer(favorite,'pointermove',{clientY:65});f.pointer(favorite,'pointerup');f.click(favorite);
  assert.equal(f.calls.favorite,0);
  f.pointer(favorite,'pointerdown');f.pointer(favorite,'pointerup');f.click(favorite);assert.equal(f.calls.favorite,1);
});

test('a new intentional touch in a portal does not inherit a blocked app gesture',t=>{
  const f=setup(t), portal=f.doc.createElement('button');f.doc.body.append(portal);
  let clicks=0;portal.addEventListener('click',()=>clicks++);
  f.pointer(f.play,'pointerdown');f.pointer(f.play,'pointercancel');
  f.pointer(portal,'pointerdown');f.pointer(portal,'pointerup');f.click(portal);
  assert.equal(clicks,1);
});

test('blur, hiding, Escape, detached targets and cleanup cannot leave delayed menus or listeners',t=>{
  const f=setup(t);
  for(const cancel of [()=>f.view.dispatchEvent(new f.view.Event('blur')),()=>f.doc.dispatchEvent(new f.view.KeyboardEvent('keydown',{key:'Escape'})),
    ()=>{Object.defineProperty(f.doc,'hidden',{value:true,configurable:true});f.doc.dispatchEvent(new f.view.Event('visibilitychange'));}]) {
    f.pointer(f.play,'pointerdown');cancel();f.advance(TILE_MOTION.longPress);assert.equal(f.calls.contexts.length,0);
  }
  f.pointer(f.play,'pointerdown');f.play.remove();f.advance(TILE_MOTION.longPress);assert.equal(f.calls.contexts.length,0);
  f.root.append(f.play);f.pointer(f.play,'pointerdown');f.close();f.advance(TILE_MOTION.longPress);
  assert.equal(f.timers.size,0);assert.equal(f.calls.contexts.length,0);
  f.click();assert.equal(f.calls.play,1,'cleanup removes the click guard');
});
