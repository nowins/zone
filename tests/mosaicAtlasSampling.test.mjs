import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { irisCoverCropUv } from "../.tmp/visualizer-tests/utils/irisGpuRenderer.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/iris-runtime-atlas-border.json", import.meta.url), "utf8"));

test("native UVs identify integer texture edges with a replicated one-texel gutter", () => {
  const [x0, y0, x1, y1] = fixture.rect;
  assert.equal(fixture.provenance.captureSha256, "cd2c4768e7bf0c6c13c454317ad96fd4be994ce13f57b42267e2172bad083f83");
  assert.equal(fixture.provenance.format, 21);
  const coordinates = fixture.quad.map(vertex => vertex.uv0.map((v, i) => v * fixture.provenance.dimensions[i]));
  assert.deepEqual(new Set(coordinates.map(p => p[0])), new Set([x0, x1]));
  assert.deepEqual(new Set(coordinates.map(p => p[1])), new Set([y0, y1]));
  for (const [name, edge] of Object.entries(fixture.edges)) {
    const gutter = Buffer.from(edge.gutter, "base64"), content = Buffer.from(edge.content, "base64");
    assert.equal(gutter.length, 4 * (name === "top" || name === "bottom" ? x1 - x0 : y1 - y0));
    assert.deepEqual(gutter, content, "transparent or black padding would change LINEAR sampling at the border");
    for (let index = 3; index < content.length; index += 4) assert.equal(content[index], 255);
  }
  for (const corner of fixture.corners) assert.deepEqual(corner.gutter, corner.content);
});

test("CLAMP_TO_EDGE reproduces native replicated neighbors without a half-texel UV inset", () => {
  assert.deepEqual(irisCoverCropUv(86, 86), [{u:0,v:0},{u:1,v:0},{u:1,v:1},{u:0,v:1}]);
  for (const edge of Object.values(fixture.edges)) {
    const gutter = Buffer.from(edge.gutter, "base64"), content = Buffer.from(edge.content, "base64");
    for (const fraction of [0, .125, .5, .875, 1]) {
      for (let index = 0; index < content.length; index++) {
        const atlasSample = gutter[index] * (1 - fraction) + content[index] * fraction;
        const independentTextureSample = content[index];
        assert.equal(atlasSample, independentTextureSample);
      }
    }
  }
});
