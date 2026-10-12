import assert from "node:assert/strict";
import test from "node:test";
import { createMosaicLightingSampler, createMosaicColorFieldMotion, mosaicLightFalloff, mosaicOverlay } from "../.tmp/visualizer-tests/utils/mosaicLighting.js";
import { projectMosaicPoint, drawProjectedMosaicImage } from "../.tmp/visualizer-tests/utils/mosaicProjection.js";

test("point light attenuation and overlay agree with the shipped HLSL examples", () => {
  assert.equal(mosaicLightFalloff(0), 5 / 7);
  assert.equal(mosaicLightFalloff(400), 1 / 3);
  assert.equal(mosaicOverlay(0.25, 0.8), 0.4);
  assert.equal(mosaicOverlay(0.75, 0.2), 0.6);
  assert.ok(mosaicLightFalloff(1000) < mosaicLightFalloff(400));
});

test("moving lights close without a loop seam and scale positions in logical pixels", () => {
  for (let path = 0; path < 3; path++) {
    assert.deepEqual(createMosaicColorFieldMotion(0, path), createMosaicColorFieldMotion(90, path));
    const before = createMosaicColorFieldMotion(89.999, path), after = createMosaicColorFieldMotion(90.001, path);
    for (const light of ["highlight1", "highlight2"]) for (let axis = 0; axis < 2; axis++) {
      assert.ok(Math.abs(before[light][axis] - after[light][axis]) < 0.00001);
    }
  }
  const palette = [{ r: 60, g: 50, b: 40 }, { r: 70, g: 40, b: 25 }, { r: 25, g: 65, b: 70 }];
  const normal = createMosaicLightingSampler(palette, 0, 1180, 760), large = createMosaicLightingSampler(palette, 0, 2360, 1520);
  assert.notDeepEqual(normal(0.5, 0.5), large(0.5, 0.5), "light radius stays in logical pixels rather than stretching with the window");
});

test("Y projection preserves flat artwork and creates near/far trapezoid edges", () => {
  assert.deepEqual(projectMosaicPoint(280, 280, 0, 0, 0), { x: 0, y: 0 });
  assert.deepEqual(projectMosaicPoint(280, 280, 0, 1, 1), { x: 280, y: 280 });
  const angle = Math.PI / 3;
  const tl = projectMosaicPoint(280, 280, angle, 0, 0), bl = projectMosaicPoint(280, 280, angle, 0, 1);
  const tr = projectMosaicPoint(280, 280, angle, 1, 0), br = projectMosaicPoint(280, 280, angle, 1, 1);
  assert.ok(bl.y - tl.y > br.y - tr.y, "near edge appears taller than the far edge");
  assert.ok(tr.x - tl.x < 280 && tr.x > tl.x, "texture compresses without mirroring");
  const reverse = projectMosaicPoint(280, 280, -angle, 1, 0);
  assert.ok(Math.abs(reverse.x - (280 - tl.x)) < 1e-10);
  for (const edge of [70, 210, 280, 4000]) for (const radians of [-Math.PI / 2, 0, Math.PI / 2]) {
    const p = projectMosaicPoint(edge, edge, radians, 0, 0);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), "camera never crosses the projection plane");
  }
});

test("projected triangles map the same texture surface with bounded work", () => {
  const transforms = [], draws = [], composites = [];
  const mesh = { globalAlpha: 1, save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {}, clearRect() {}, setTransform() {},
    moveTo() {}, lineTo() {}, transform(...matrix) { transforms.push(matrix); }, drawImage(surface) { draws.push(surface); } };
  const surface = { width: 0, height: 0, getContext: () => mesh };
  const image = { width: 256, height: 256, ownerDocument: { createElement: () => surface } };
  const context = { globalAlpha: 0.4, save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {},
    moveTo() {}, lineTo() {}, drawImage(image) { composites.push({ image, alpha: this.globalAlpha }); } };
  drawProjectedMosaicImage(context, image, 20, 40, 280, 280, Math.PI / 4);
  assert.equal(draws.length, 16);
  assert.ok(draws.every(surface => surface === image));
  assert.deepEqual(composites, [{ image: surface, alpha: 0.4 }], "the whole face receives opacity once, including shared edges");
  assert.equal(mesh.globalAlpha, 1, "internal triangle overlaps remain opaque");
  assert.ok(surface.width <= 1024 && surface.height <= 1024);
  transforms.forEach(([a, b, c, d, e, f]) => {
    assert.ok([a, b, c, d, e, f].every(Number.isFinite));
    assert.ok(a * d - b * c > 0, "each texture triangle retains its orientation");
  });
});
