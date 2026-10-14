import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createMosaicColorFieldMotion } from "../.tmp/visualizer-tests/utils/mosaicLighting.js";
import { MOSAIC_MOODS, createMosaicPaletteClock, advanceMosaicPalette, advanceMosaicLightClips } from "../.tmp/visualizer-tests/utils/mosaicPalette.js";

test("native keyframe milliseconds give each lamp its own loop", () => {
  assert.deepEqual(createMosaicColorFieldMotion(15, 0).highlight1, [1, 0]);
  assert.deepEqual(createMosaicColorFieldMotion(18, 0).highlight2, [.4, .9]);
  assert.deepEqual(createMosaicColorFieldMotion(75, 0).highlight1, [.5, 0]);
  assert.deepEqual(createMosaicColorFieldMotion(72, 0).highlight2, [.1, 1]);
  assert.notDeepEqual(createMosaicColorFieldMotion(75, 0).highlight2, [.1, 1]);
  assert.deepEqual(createMosaicColorFieldMotion(12.857, 1), { highlight1: [0, .5], highlight2: [1, .7] });
  assert.deepEqual(createMosaicColorFieldMotion(77.143, 1), createMosaicColorFieldMotion(0, 1));
  assert.deepEqual(createMosaicColorFieldMotion(72, 2).highlight1, [1, .2]);
  assert.deepEqual(createMosaicColorFieldMotion(77.143, 2).highlight2, [0, .5]);
  for (const [path, lamp, duration] of [[0,"highlight1",75],[0,"highlight2",72],
    [1,"highlight1",77.143],[1,"highlight2",77.143],[2,"highlight1",72],[2,"highlight2",77.143]]) {
    const left = createMosaicColorFieldMotion(duration - .000001, path)[lamp];
    const right = createMosaicColorFieldMotion(duration + .000001, path)[lamp];
    assert.ok(Math.hypot(left[0]-right[0], left[1]-right[1]) < .00001, "repeated endpoint keeps the loop continuous");
  }
});

test("palette bytes agree with independently captured wall and photo constants", () => {
  assert.deepEqual(MOSAIC_MOODS.map(mood => mood.length), [5,5,5,5,5]);
  for (const [fixture, bytes] of [["iris-runtime-pixel-shader.json",MOSAIC_MOODS[3][2]],
    ["iris-runtime-photo-shader.json",MOSAIC_MOODS[0][0]]]) {
    const runtime = JSON.parse(readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), "utf8"));
    const registers = runtime.sample.constantRegisters;
    for (const [index, register] of ["c8","c2","c6"].entries()) {
      for (let channel = 0; channel < 3; channel++) {
        assert.ok(Math.abs(bytes[index][channel] / 255 - registers[register][channel]) < .000001);
      }
      assert.equal(registers[register][3], 1);
    }
  }
});

test("palette host changes within one mood every 20 seconds with a 4 second linear RGBA entrance", () => {
  const clock = createMosaicPaletteClock(() => 0);
  const target = clock.target;
  advanceMosaicPalette(clock, 2000, true, false);
  assert.deepEqual(clock.palette, target.map(c => ({r:c.r/2,g:c.g/2,b:c.b/2,a:.5})));
  advanceMosaicPalette(clock, 18000, true, false, () => .3);
  assert.deepEqual(clock.palette, target, "new transition starts from the last target");
  assert.equal(clock.moodIndex, 0);
  const next = clock.target;
  assert.notDeepEqual(next, target);
  advanceMosaicPalette(clock, 2000, true, false);
  assert.deepEqual(clock.palette, target.map((c,i) => ({r:(c.r+next[i].r)/2,g:(c.g+next[i].g)/2,b:(c.b+next[i].b)/2,a:1})));
  const paused = structuredClone(clock);
  advanceMosaicPalette(clock, 60000, false, false);
  assert.deepEqual(clock, paused, "pause cannot advance palette or interval");
  advanceMosaicPalette(clock, 60000, true, true);
  assert.equal(clock.elapsedMs, paused.elapsedMs);
  assert.deepEqual(clock.palette, next, "reduced motion settles to a static target");
});

test("photo lights restart per clip and retain two independent clocks during a dissolve", () => {
  const target = createMosaicPaletteClock(() => 0).target;
  const clips = {current:null,previous:null};
  advanceMosaicLightClips(clips,"first",null,target,0,true,false,()=>0);
  advanceMosaicLightClips(clips,"first",null,target,32000,true,false);
  assert.equal(clips.current.pathIndex, 0);
  advanceMosaicLightClips(clips,"second","first",target,0,true,false,()=>.9);
  assert.equal(clips.current.pathIndex, 2);
  assert.equal(clips.current.elapsedMs, 0);
  assert.equal(clips.current.palette[0].a, 0);
  assert.equal(clips.previous.elapsedMs, 32000);
  advanceMosaicLightClips(clips,"second","first",target,1000,true,false);
  assert.equal(clips.current.elapsedMs, 1000);
  assert.equal(clips.previous.elapsedMs, 33000);
  assert.equal(clips.current.palette[0].a, .25);
  assert.equal(clips.previous.palette[0].a, 1);
  const paused = structuredClone(clips);
  advanceMosaicLightClips(clips,"second","first",target,2000,false,false);
  assert.deepEqual(clips, paused);
  advanceMosaicLightClips(clips,"second",null,target,0,true,true);
  assert.equal(clips.previous, null);
  assert.deepEqual(clips.current.palette, target);
  advanceMosaicLightClips(clips,"second",null,target,16,true,false);
  assert.deepEqual(clips.current.palette, target, "leaving reduced motion cannot restart the transparent entrance");
});
