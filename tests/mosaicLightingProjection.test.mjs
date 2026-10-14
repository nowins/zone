import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createMosaicLightingSampler, createMosaicColorFieldMotion, mosaicLightFalloff, mosaicOverlay } from "../.tmp/visualizer-tests/utils/mosaicLighting.js";
import { createMosaicCamera, projectMosaicPoint, drawProjectedMosaicImage } from "../.tmp/visualizer-tests/utils/mosaicProjection.js";

const runtime = JSON.parse(readFileSync(new URL("./fixtures/iris-runtime-matrices.json", import.meta.url), "utf8"));

function multiplyMatrices(left, right) {
  return Array.from({ length: 16 }, (_, index) => {
    const row = Math.floor(index / 4), column = index % 4;
    return [0, 1, 2, 3].reduce((sum, k) => sum + left[row * 4 + k] * right[k * 4 + column], 0);
  });
}

function rowVector(vector, matrix) {
  return [0, 1, 2, 3].map(column => vector.reduce((sum, value, row) => sum + value * matrix[row * 4 + column], 0));
}

function viewportPoint(clip, viewport, dpi) {
  return {
    x: ((clip[0] / clip[3] + 1) * viewport.width / 2 + 0.5) / dpi,
    y: ((1 - clip[1] / clip[3]) * viewport.height / 2 + 0.5) / dpi,
  };
}

function nearPoint(actual, expected, tolerance) {
  for (const axis of ["x", "y"]) {
    assert.ok(Math.abs(actual[axis] - expected[axis]) < tolerance,
      `${axis}: expected ${expected[axis]}, got ${actual[axis]}`);
  }
}

test("point light attenuation and overlay agree with the shipped HLSL examples", () => {
  assert.equal(mosaicLightFalloff(0), 5 / 7);
  assert.equal(mosaicLightFalloff(400), 1 / 3);
  assert.equal(mosaicOverlay(0.25, 0.8), 0.4);
  assert.equal(mosaicOverlay(0.75, 0.2), 0.6);
  assert.ok(mosaicLightFalloff(1000) < mosaicLightFalloff(400));
});

test("moving lights close without a loop seam and scale positions in logical pixels", () => {
  // Loop boundaries are independently covered by mosaicAmbientLighting.
  assert.notDeepEqual(createMosaicColorFieldMotion(0), createMosaicColorFieldMotion(90));
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

test("DPI projection agrees with physical window matrices and keeps parent XYZ scale separate", () => {
  // The first three are fixed arithmetic anchors for native S × V × P, not
  // camera-derived expectations. DPI 2 uses the actual 3840 × 2064 float matrix.
  const cases = [
    { dpi: 1, width: 1180, height: 760, viewport: { width: 1180, height: 760 }, distance: 5900,
      center: { x: 590.5, y: 380.5 },
      matrix: [10, 0, 0, 0, 0, -15.526315789473684, 0, 0, 0, 0, 1.5, 1, -5905, 5907.763157894737, 4425, 5900] },
    { dpi: 1.25, width: 1180, height: 760, viewport: { width: 1475, height: 950 }, distance: 7375,
      center: { x: 590.4, y: 380.4 },
      matrix: [10, 0, 0, 0, 0, -15.526315789473684, 0, 0, 0, 0, 1.5, 1, -7380, 7382.763157894737, 5531.25, 7375] },
    { dpi: 3, width: 1180, height: 760, viewport: { width: 3540, height: 2280 }, distance: 17700,
      center: { x: 590.1666666666666, y: 380.1666666666667 },
      matrix: [10, 0, 0, 0, 0, -15.526315789473684, 0, 0, 0, 0, 1.5, 1, -17705, 17707.763157894737, 13275, 17700] },
    { dpi: runtime.spGetDpi / 96, width: 1920, height: 1032, viewport: runtime.viewport, distance: 19200,
      center: { x: 960.25, y: 516.25 }, matrix: runtime.projection },
  ];
  for (const fixture of cases) {
    for (const scale of [1, 1.03, 1.6]) {
      const camera = createMosaicCamera(fixture.width, fixture.height, scale, 12, -8, fixture.dpi);
      assert.equal(camera.distance, fixture.distance, "physical focal depth must retain the full DPI factor, including DPI > raster cap 2");
      nearPoint({ x: camera.centerX, y: camera.centerY }, fixture.center, 1e-12);
      // Compose native row-vector matrices independently of the pinhole formula.
      const parent = [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0,
        fixture.width / 2 * (1 - scale) + 12 * scale,
        fixture.height / 2 * (1 - scale) - 8 * scale, 0, 1];
      const dpiXY = [fixture.dpi, 0, 0, 0, 0, fixture.dpi, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      for (const tile of [{ x: 0, y: 70, width: 280, height: 280 },
        { x: fixture.width - 210, y: fixture.height - 280, width: 70, height: 70 }]) {
        for (const angle of [-Math.PI / 3, 0, Math.PI / 3]) {
          const c = Math.cos(angle), s = Math.sin(angle), pivot = tile.x + tile.width / 2;
          const rotation = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, pivot * (1 - c), 0, pivot * s, 1];
          const pipeline = multiplyMatrices(multiplyMatrices(multiplyMatrices(rotation, parent), dpiXY), fixture.matrix);
          for (const [u, v] of [[0, 0], [0.5, 0.5], [1, 1]]) {
            const clip = rowVector([tile.x + u * tile.width, tile.y + v * tile.height, 0, 1], pipeline);
            const expected = viewportPoint(clip, fixture.viewport, fixture.dpi);
            const point = projectMosaicPoint(tile, camera, angle, u, v);
            const painted = rowVector([point.x, point.y, 0, 1], parent);
            nearPoint({ x: painted[0], y: painted[1] }, expected, fixture.dpi === 2 ? 0.0002 : 1e-10);
          }
        }
      }
    }
  }
});

test("captured CPU matrix composition matches vertex constant readback after float storage", () => {
  for (const frame of [runtime.flat, runtime.rotated]) {
    const calculated = multiplyMatrices(frame.worldView, runtime.projection);
    assert.deepEqual(calculated.map(Math.fround), frame.readback,
      `draw ${frame.drawSeq} stores row-major WorldView × Projection with float rounding`);
  }
  const doubleMatrix = multiplyMatrices(runtime.rotated.worldView, runtime.projection);
  assert.equal(doubleMatrix[14], 12753.214965820312);
  assert.equal(doubleMatrix[15], 18102.143310546875);
  assert.notEqual(doubleMatrix[15], runtime.rotated.readback[15], "the captured matrix is not an unrounded JS double fixture");
  assert.equal(runtime.flat.worldView[0], 2);
  assert.equal(runtime.flat.worldView[5], 2);
  assert.equal(runtime.flat.worldView[10], 1, "Frame DPI scale leaves depth unscaled");
});

test("DPI camera reproduces an observed negative Y turn using the native readback matrix", () => {
  const dpi = runtime.spGetDpi / 96;
  const world = runtime.rotated.worldView;
  const angle = Math.atan2(-world[2], world[0] / dpi);
  // The observed matrix rotates about x≈1641. These are arbitrary geometry
  // probe points at that pivot, not a claim that the capture included vertices.
  assert.ok(Math.abs(world[14] / -world[2] - 1641) < 0.0001);
  const tile = { x: 1501, y: 200, width: 280, height: 280 };
  const camera = createMosaicCamera(1920, 1032, 1, 0, 0, dpi);
  for (const [u, v] of [[0, 0], [0.25, 0.3], [0.5, 0.5], [0.75, 0.7], [1, 1]]) {
    const clip = rowVector([tile.x + u * tile.width, tile.y + v * tile.height, 0, 1], runtime.rotated.readback);
    const expected = viewportPoint(clip, runtime.viewport, dpi);
    nearPoint(projectMosaicPoint(tile, camera, angle, u, v), expected, 0.0005);
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
