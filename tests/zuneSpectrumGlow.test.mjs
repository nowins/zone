import assert from "node:assert/strict";
import test from "node:test";
import { createZuneGlowBands, EMPTY_GLOW_BANDS, GLOW_LEFT_INDICES, ZuneGlowAnimator, zuneGlowResponse, zuneGlowSprites } from "../.tmp/visualizer-tests/utils/zuneSpectrumGlow.js";

const pcm = Uint8Array.from({ length: 2048 }, (_, i) => 128 + Math.round(50 * Math.sin(i * 0.2)));
const silent = new Uint8Array(2048).fill(128);

test("adjacent bytes form one normalized band and retain stereo spatial order", () => {
  const left = new Uint8Array(1024), right = new Uint8Array(1024);
  left.set([40, 80, 120, 160], 4); right.set([255, 255, 255, 255], 4);
  left.set([80, 80, 80, 80], 255 * 4);
  const bands = createZuneGlowBands(left, right, pcm, pcm);
  assert.equal(bands.length, 40);
  assert.equal(bands[0], 80 / 255);
  assert.equal(bands[19], 100 / 255);
  assert.equal(bands[20], 1);
  assert.ok(bands.slice(1, 19).every(value => value === 0));
  assert.deepEqual(GLOW_LEFT_INDICES.slice(-4), [4, 3, 2, 1]);
});

test("PCM silence gates FFT tails independently on either side, without downmix cancellation", () => {
  const spectrum = new Uint8Array(1024).fill(200);
  const bands = createZuneGlowBands(spectrum, spectrum, pcm, silent);
  assert.ok(bands.slice(0, 20).every(value => value === 200 / 255));
  assert.ok(bands.slice(20).every(value => value === 0));
  assert.deepEqual(createZuneGlowBands(spectrum, spectrum, silent, silent), [...EMPTY_GLOW_BANDS]);
  const opposite = Uint8Array.from(pcm, value => 256 - value);
  assert.ok(createZuneGlowBands(spectrum, spectrum, pcm, opposite).every(value => value > 0));
});

test("overlap covers both edges and both responses preserve medium-signal contrast", () => {
  const orange = zuneGlowSprites(new Array(40).fill(zuneGlowResponse(0.5, "orange")), 1180);
  const pink = zuneGlowSprites(new Array(40).fill(zuneGlowResponse(0.5, "pink")), 1180);
  assert.equal(orange[0].x, 0);
  assert.ok(Math.abs(orange.at(-1).x + orange.at(-1).width - 1180) < 1e-9);
  assert.equal(orange[0].width, 1180 * 9 / 48);
  assert.equal(orange[0].height, 16.875); assert.equal(orange[0].alpha, 0.0625);
  assert.equal(pink[0].height, 33.75); assert.equal(pink[0].alpha, 0.125);
  for (const bad of [NaN, Infinity, -1]) assert.equal(zuneGlowResponse(bad, "pink"), 0);
});

test("each layer snapshots on its own cycle, holds sustained input and releases to zero", () => {
  for (const [name, cycle, expected] of [["orange", 67, 0.125], ["pink", 50, 0.25]]) {
    const animation = new ZuneGlowAnimator(name);
    const bands = new Array(40).fill(0.5);
    assert.ok(animation.update(0, bands).every(value => value === 0));
    const first = animation.update(cycle / 2, bands)[0];
    assert.ok(first > 0 && first < expected);
    assert.ok(animation.update(cycle, bands).every(value => value === expected));
    assert.ok(animation.update(800, bands).every(value => value === expected), "steady sound does not pulse with time");
    animation.update(801, EMPTY_GLOW_BANDS);
    for (let time = 817; time < 1100; time += 16) animation.update(time, EMPTY_GLOW_BANDS);
    assert.equal(animation.active, false);
    assert.ok(animation.update(1100, EMPTY_GLOW_BANDS).every(value => value === 0));
    animation.reset();
    assert.ok(animation.update(0, EMPTY_GLOW_BANDS).every(value => value === 0));
  }
});
