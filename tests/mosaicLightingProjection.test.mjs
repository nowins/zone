import assert from "node:assert/strict";
import test from "node:test";
import { createMosaicLightingSampler, createMosaicColorFieldMotion, mosaicLightFalloff, mosaicOverlay } from "../.tmp/visualizer-tests/utils/mosaicLighting.js";
import { createMosaicCamera, projectMosaicPoint, drawProjectedMosaicImage } from "../.tmp/visualizer-tests/utils/mosaicProjection.js";

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
  const tile = { x: 450, y: 240, width: 280, height: 280 }, camera = createMosaicCamera(1180, 760);
  const project = (angle, u, v) => projectMosaicPoint(tile, camera, angle, u, v);
  assert.deepEqual(project(0, 0, 0), { x: 450, y: 240 });
  assert.deepEqual(project(0, 1, 1), { x: 730, y: 520 });
  const angle = Math.PI / 3;
  const tl = project(angle, 0, 0), bl = project(angle, 0, 1);
  const tr = project(angle, 1, 0), br = project(angle, 1, 1);
  assert.ok(br.y - tr.y > bl.y - tl.y, "positive Iris Y rotation brings the right edge toward the camera");
  assert.ok(tr.x - tl.x < 280 && tr.x > tl.x, "texture compresses without mirroring");
  const reverse = project(-angle, 1, 0);
  assert.equal(reverse.y, tl.y, "reversing rotation swaps near and far depths");
  for (const edge of [70, 210, 280, 4000]) for (const radians of [-Math.PI / 2, 0, Math.PI / 2]) {
    const p = projectMosaicPoint({ x: 0, y: 0, width: edge, height: edge }, createMosaicCamera(edge, edge), radians, 0, 0);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), "camera never crosses the projection plane");
  }
});

test("shared viewport projection agrees with the recovered row-vector S × V × P matrix", () => {
  // Native 1180 × 760 default window: s=590, Eye=-5900, Zn=2950, Zf=8850.
  // This matrix is an independent arithmetic fixture from FUN_310a7bbc.
  const matrix = [10, 0, 0, 0, 0, -11800 / 760, 0, 0, 0, 0, 1.5, 1, -5905, 380.5 * 11800 / 760, 4425, 5900];
  const camera = createMosaicCamera(1180, 760, 1.03, 12, -8);
  assert.equal(camera.distance, 5900, "focal distance follows the whole viewport, independent of tile size");
  for (const tile of [{x: 0, y: 50, width: 280, height: 280}, {x: 980, y: 600, width: 70, height: 70}]) {
    for (const angle of [-1, 0, 1]) for (const [u, v] of [[0, 0], [0.5, 0.5], [1, 1]]) {
      const dx = (u - 0.5) * tile.width;
      const input = [(tile.x + tile.width / 2 + dx * Math.cos(angle)) * camera.scale + camera.offsetX,
        (tile.y + v * tile.height) * camera.scale + camera.offsetY, -dx * Math.sin(angle) * camera.scale, 1];
      const clip = [0, 1, 2, 3].map(column => input.reduce((sum, value, row) => sum + value * matrix[row * 4 + column], 0));
      const expected = {x: ((clip[0] / clip[3] + 1) * 590 + 0.5 - camera.offsetX) / camera.scale,
        y: ((1 - clip[1] / clip[3]) * 380 + 0.5 - camera.offsetY) / camera.scale};
      const actual = projectMosaicPoint(tile, camera, angle, u, v);
      assert.ok(Math.abs(actual.x - expected.x) < 1e-10 && Math.abs(actual.y - expected.y) < 1e-10);
    }
  }
  const left = projectMosaicPoint({x:0, y:100, width:280, height:280}, camera, 1, 1, 0);
  const right = projectMosaicPoint({x:900, y:100, width:280, height:280}, camera, 1, 1, 0);
  assert.notEqual(right.x - left.x, 900, "a shared optical center changes projection with screen position");
  assert.equal(createMosaicCamera(920, 620).distance, 4600);
  assert.equal(createMosaicCamera(760, 1180).distance, 5900);
});

test("projected triangles map the same texture surface with bounded work", () => {
  const transforms = [], draws = [], composites = [];
  const mesh = { globalAlpha: 1, save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {}, clearRect() {}, setTransform() {},
    moveTo() {}, lineTo() {}, transform(...matrix) { transforms.push(matrix); }, drawImage(surface) { draws.push(surface); } };
  const surface = { width: 0, height: 0, getContext: () => mesh };
  const image = { width: 256, height: 256, ownerDocument: { createElement: () => surface } };
  const context = { globalAlpha: 0.4, save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {},
    moveTo() {}, lineTo() {}, drawImage(image) { composites.push({ image, alpha: this.globalAlpha }); } };
  drawProjectedMosaicImage(context, image, {x:20, y:40, width:280, height:280}, createMosaicCamera(1180, 760), Math.PI / 4);
  assert.equal(draws.length, 16);
  assert.ok(draws.every(surface => surface === image));
  assert.deepEqual(composites, [{ image: surface, alpha: 0.4 }], "the whole face receives opacity once, including shared edges");
  assert.equal(mesh.globalAlpha, 1, "internal triangle overlaps remain opaque");
  assert.ok(surface.width <= 1024 && surface.height <= 1024);
  transforms.forEach(([a, b, c, d, e, f]) => {
    assert.ok([a, b, c, d, e, f].every(Number.isFinite));
    assert.ok(a * d - b * c > 0, "each texture triangle retains its orientation");
  });
  for (const edge of [70, 280, 4096]) for (const radians of [-1.3, 0.1, 1.3]) {
    drawProjectedMosaicImage(context, image, {x:100, y:100, width:edge, height:edge}, createMosaicCamera(7680, 4320), radians);
    assert.ok(surface.width <= 1024 && surface.height <= 1024, "rounding projected bounds cannot exceed the raster budget");
  }
});
