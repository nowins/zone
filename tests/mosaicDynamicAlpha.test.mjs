import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mosaicCoverVertexAlpha } from "../.tmp/visualizer-tests/utils/mosaicCoverMaterial.js";
import { createMosaicCamera, projectMosaicPoint, projectMosaicVertex } from "../.tmp/visualizer-tests/utils/mosaicProjection.js";

const runtime = JSON.parse(readFileSync(new URL("./fixtures/iris-runtime-dynamic-alpha.json", import.meta.url), "utf8"));

test("dynamic COLOR0 comes from four actually indexed vertices, including rotating faces", () => {
  assert.equal(runtime.coverage.draws, 108);
  assert.equal(runtime.coverage.turning, 51);
  assert.equal(runtime.provenance.detached, true);
  assert.deepEqual(runtime.provenance.errors, []);
  for (const draw of runtime.samples) {
    assert.deepEqual(new Set(draw.indices.map(index => index + draw.baseVertexIndex)), new Set(draw.selected.map(vertex => vertex.index)));
    assert.equal(draw.stride, 48);
    assert.equal(draw.selected.length, 4);
    for (let index = 0; index < 4; index++) {
      const bytes = Buffer.from(draw.selected[index].dataHex, "hex");
      assert.equal(bytes.length, draw.stride);
      const packed = bytes.readUInt32LE(12);
      assert.equal(packed >>> 24, draw.alphas[index]);
      assert.equal(packed & 0xffffff, 0xffffff);
    }
  }
});

test("front alpha independently agrees with the angle recovered from actual WVP", () => {
  const fronts = runtime.samples.filter(draw => draw.wvp[3] < -0.00015);
  assert.ok(fronts.length >= 20);
  for (const draw of fronts) {
    // Settled WVP row0.x is 20. Rotation independently supplies cos/sin;
    // do not derive normalized progress from the packed alpha under test.
    const angle = Math.atan2(-draw.wvp[3], draw.wvp[0] / 20);
    const amount = 1 - angle / (Math.PI / 2);
    const nativeByte = Math.floor(255 * 0.35 * amount);
    assert.equal(draw.alphas[0], nativeByte);
    assert.equal(mosaicCoverVertexAlpha(amount) * 255, nativeByte);
  }
});

test("back fade continues after rotation has landed and uses discrete vertex alpha", () => {
  const landed = runtime.samples.filter(draw => !draw.turning && draw.alphas[0] > 0 && draw.alphas[0] < 89);
  assert.ok(landed.length >= 25);
  const values = new Set(landed.map(draw => draw.alphas[0]));
  assert.ok(values.has(49) && values.has(88));
  assert.equal(mosaicCoverVertexAlpha(), 89 / 255);
  assert.equal(mosaicCoverVertexAlpha(0), 0);
  assert.equal(mosaicCoverVertexAlpha(0.5, 0.5), 22 / 255);
  assert.notEqual(mosaicCoverVertexAlpha(0.5), (89 / 255) * 0.5);
});

test("GPU projection preserves the same camera and clip W through DPI and parent scale", () => {
  for (const dpi of [1, 2, 3]) for (const angle of [-1.4, -0.7, 0, 0.7, 1.4]) {
    const camera = createMosaicCamera(1180, 760, 1.025, 4, -3, dpi);
    const tile = { x: 820, y: 80, width: 279, height: 279 };
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const point = projectMosaicPoint(tile, camera, angle, u, v);
      const vertex = projectMosaicVertex(tile, camera, angle, u, v);
      assert.equal(vertex.x, point.x * camera.scale + camera.offsetX);
      assert.equal(vertex.y, point.y * camera.scale + camera.offsetY);
      assert.ok(vertex.w > 0);
      assert.equal(vertex.w, 1 - (u - 0.5) * tile.width * Math.sin(angle) * camera.scale / camera.distance);
    }
  }
});
