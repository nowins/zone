import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

await build({ entryPoints: ["src/utils/irisGpuRenderer.ts"], outfile: ".tmp/iris-gpu-tests/runtime.js",
  bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { irisCoverCropUv, irisQuadClipVertices, irisBoundedRasterSize, createIrisGpuRenderer } = await import("../.tmp/iris-gpu-tests/runtime.js");

function near(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

test("center crop retains aspect ratio and the original texel boundary without a second square raster", () => {
  for (const [sw, sh, tw, th] of [[640, 360, 70, 70], [360, 640, 280, 280], [123, 321, 280, 70],
    [800, 450, 1600, 900], [384, 384, 70, 70]]) {
    const uv = irisCoverCropUv(sw, sh, tw, th);
    const sampledWidth = (uv[1].u - uv[0].u) * sw;
    const sampledHeight = (uv[3].v - uv[0].v) * sh;
    near(sampledWidth / sampledHeight, tw / th);
    near((uv[0].u + uv[2].u) / 2, .5);
    near((uv[0].v + uv[2].v) / 2, .5);
    assert.ok(uv.every(point => point.u >= 0 && point.u <= 1 && point.v >= 0 && point.v <= 1));
    assert.ok(uv[0].u === 0 || uv[0].v === 0, "the uncropped axis keeps its original texture edge");
  }
  assert.deepEqual(irisCoverCropUv(384, 384), [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }, { u: 0, v: 1 }]);
  for (const invalid of [0, -1, NaN, Infinity]) assert.throws(() => irisCoverCropUv(invalid, 384), RangeError);
});

test("quad upload preserves homogeneous screen positions and independent old/new crop coordinates", () => {
  const points = [{ x: -40, y: 20, w: .8 }, { x: 460, y: 60, w: 1.25 },
    { x: 450, y: 430, w: 1.25 }, { x: -60, y: 440, w: .8 }];
  const uv = irisCoverCropUv(640, 360), previousUv = irisCoverCropUv(360, 640);
  const data = irisQuadClipVertices(points, 500, 450, uv, previousUv);
  assert.equal(data.length, 28);
  for (let index = 0; index < 4; index++) {
    const [cx, cy, w, u, v, oldU, oldV] = data.subarray(index * 7, index * 7 + 7);
    near((cx / w + 1) * 250, points[index].x, 2e-5);
    near((1 - cy / w) * 225, points[index].y, 2e-5);
    near(w, points[index].w);
    near(u, uv[index].u); near(v, uv[index].v);
    near(oldU, previousUv[index].u); near(oldV, previousUv[index].v);
  }
  for (const w of [0, -1, NaN, Infinity, 1e-100]) {
    assert.throws(() => irisQuadClipVertices([{ ...points[0], w }, ...points.slice(1)], 500, 450), RangeError);
  }
  assert.throws(() => irisQuadClipVertices([{ ...points[0], x: 1e100 }, ...points.slice(1)], 500, 450), RangeError);
});

function barycentric(point, vertices) {
  const [a, b, c] = vertices;
  const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  const first = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / denominator;
  const second = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / denominator;
  return [first, second, 1 - first - second];
}

test("two triangle interpolation reconstructs rotated plane UV while affine screen UV is measurably wrong", () => {
  // Independent pinhole geometry, rather than the production projection helper.
  const angle = 1.15, width = 280, height = 210, distance = 400;
  const project = (u, v) => {
    const dx = (u - .5) * width, dy = (v - .5) * height;
    const w = (distance - dx * Math.sin(angle)) / distance;
    return { x: 240 + dx * Math.cos(angle) / w, y: 220 + dy / w, w };
  };
  const sourceUv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const points = sourceUv.map(([u, v]) => project(u, v));
  const data = irisQuadClipVertices(points, 480, 440);
  const uploaded = points.map((_, index) => {
    const [x, y, w] = data.subarray(index * 7, index * 7 + 3);
    return { x: (x / w + 1) * 240, y: (1 - y / w) * 220, w };
  });
  for (const [u, v, indices] of [[.73, .2, [0, 1, 2]], [.2, .71, [0, 2, 3]]]) {
    const weights = barycentric(project(u, v), indices.map(index => uploaded[index]));
    assert.ok(weights.every(weight => weight >= 0 && weight <= 1));
    const denominator = weights.reduce((sum, weight, index) => sum + weight / uploaded[indices[index]].w, 0);
    const reconstructed = [0, 1].map(channel => weights.reduce((sum, weight, index) =>
      sum + weight * sourceUv[indices[index]][channel] / uploaded[indices[index]].w, 0) / denominator);
    near(reconstructed[0], u); near(reconstructed[1], v);
    const affineU = weights.reduce((sum, weight, index) => sum + weight * sourceUv[indices[index]][0], 0);
    assert.ok(Math.abs(affineU - u) > .05, "using w=1 would lose the intended perspective mapping");
  }
});

test("raster bounds honor the 2x cap, the actual device edge and a fixed pixel budget", () => {
  assert.deepEqual(irisBoundedRasterSize(1180, 760, 3), { width: 2360, height: 1520, rasterScale: 2 });
  assert.deepEqual(irisBoundedRasterSize(920, 620, 1.25), { width: 1150, height: 775, rasterScale: 1.25 });
  for (const [width, height, scale, edge] of [[7680, 4320, 3, 16384], [10000, 10000, 2, 8192],
    [1, 10000, 2, 4096], [9999, 3, 2, 1024], [.1, .2, 1, 2048]]) {
    const raster = irisBoundedRasterSize(width, height, scale, edge);
    assert.ok(raster.width >= 1 && raster.height >= 1 && raster.width <= edge && raster.height <= edge);
    assert.ok(raster.width * raster.height <= 16_777_216);
    assert.ok(raster.rasterScale > 0 && raster.rasterScale <= 2 && raster.rasterScale <= scale);
    if (width > 1 && height > 1) {
      near(raster.width / width, raster.height / height, 1 / Math.min(width, height));
    }
  }
  for (const value of [0, -1, NaN, Infinity]) assert.throws(() => irisBoundedRasterSize(value, 760, 2), RangeError);
});

test("an unavailable or rejected browser context returns null for the existing Canvas fallback", () => {
  const requests = [];
  assert.equal(createIrisGpuRenderer({ createElement() { return { getContext(type) { requests.push(type); return null; } }; } }), null);
  assert.deepEqual(requests, ["webgl2", "webgl"]);
  assert.equal(createIrisGpuRenderer({ createElement() { return { getContext() { throw new Error("GPU policy disabled"); } }; } }), null);
});
