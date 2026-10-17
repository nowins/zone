import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inflateSync } from "node:zlib";

const runtime = JSON.parse(readFileSync(new URL("./fixtures/iris-runtime-transparent-texture.json", import.meta.url), "utf8"));
const source = Buffer.from(runtime.source.rgbaHex, "hex");
const cpu = Buffer.from(runtime.nativeCpuDecoded.bgraHex, "hex");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sourcePixel = (x, y) => [...source.subarray((y * runtime.source.width + x) * 4, (y * runtime.source.width + x + 1) * 4)];

function pixelFromBgra(bytes, offset) {
  return [bytes[offset + 2], bytes[offset + 1], bytes[offset], bytes[offset + 3]];
}

function atlasPixel(observation, x, y) {
  const atlas = observation.atlas;
  const [left, top, right, bottom] = atlas.regionRectExclusive;
  assert.ok(x >= left && x < right && y >= top && y < bottom, "requested texel must be inside retained native region");
  const bytes = Buffer.from(atlas.regionBgraHex, "hex");
  return pixelFromBgra(bytes, ((y - top) * atlas.regionWidth + x - left) * 4);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Independent LINEAR texel-center rule. Native atlas coordinates are not
// clamped to the subimage: its duplicated gutter supplies the boundary texels.
function bilinear(x, y, readPixel) {
  const left = Math.floor(x), top = Math.floor(y);
  const fx = x - left, fy = y - top;
  const corners = [readPixel(left, top), readPixel(left + 1, top), readPixel(left, top + 1), readPixel(left + 1, top + 1)];
  return [0, 1, 2, 3].map(channel => corners[0][channel] * (1 - fx) * (1 - fy)
    + corners[1][channel] * fx * (1 - fy) + corners[2][channel] * (1 - fx) * fy + corners[3][channel] * fx * fy);
}

test("transparent source PNG, original CPU decode and byte provenance agree", () => {
  assert.equal(runtime.source.pngSha256, "d356c8a9af93dc2e3da56119306ccf06a7abe7fdc0ecd6d0219a7bd22db56916");
  assert.equal(runtime.source.rgbaSha256, "221a30cfd9a4ee8ce2846dd981bf52ebb2c603896d662936e9917bd46418e743");
  assert.equal(runtime.nativeCpuDecoded.sha256, "8e5c8d02825448d07fecdbc2e6f08c719cd859767c9ccd8bcd51255babe60ce0");
  assert.equal(sha256(source), runtime.source.rgbaSha256);
  assert.equal(sha256(cpu), runtime.nativeCpuDecoded.sha256);
  assert.equal(source.length, 8 * 2 * 4);
  assert.equal(cpu.length, 64);
  assert.equal(runtime.nativeCpuDecoded.stride, 32);
  assert.equal(runtime.nativeCpuDecoded.surfaceFormat, 2132104, "Iris ARGB32 is distinct from D3DFMT21");

  const png = Buffer.from(runtime.source.pngHex, "hex");
  assert.equal(sha256(png), runtime.source.pngSha256);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const names = [], payloads = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    const name = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + size);
    assert.equal(crc32(png.subarray(offset + 4, offset + 8 + size)), png.readUInt32BE(offset + 8 + size));
    if (name === "IHDR") {
      assert.equal(data.readUInt32BE(0), 8);
      assert.equal(data.readUInt32BE(4), 2);
      assert.equal(data[8], 8);
      assert.equal(data[9], 6, "source is RGBA8 rather than a JPEG or opaque palette image");
    }
    if (name === "IDAT") payloads.push(data);
    names.push(name);
    offset += size + 12;
  }
  assert.deepEqual(names, ["IHDR", "IDAT", "IEND"], "no profile/gamma chunks are hidden in the controlled source");
  const scanlines = inflateSync(Buffer.concat(payloads));
  assert.equal(scanlines.length, 66);
  const decodedSource = Buffer.concat([scanlines.subarray(1, 33), scanlines.subarray(34, 66)]);
  assert.equal(scanlines[0], 0);
  assert.equal(scanlines[33], 0);
  assert.deepEqual(decodedSource, source, "PNG's actual compressed pixel payload, not its declaration, identifies the source");
  assert.deepEqual(Array.from({ length: 16 }, (_, i) => pixelFromBgra(cpu, i * 4)),
    Array.from({ length: 16 }, (_, i) => sourcePixel(i % 8, Math.floor(i / 8))));
});

test("observed source preserves transparent RGB and disagrees with premultiplied storage", () => {
  assert.equal(runtime.source.premultiplied, false);
  assert.deepEqual(sourcePixel(0, 0), [240, 16, 80, 0]);
  assert.deepEqual(sourcePixel(0, 1), [32, 224, 96, 0]);
  assert.deepEqual(sourcePixel(3, 0), [240, 16, 80, 64]);
  assert.deepEqual(sourcePixel(4, 1), [144, 216, 8, 128]);
  let informative = 0;
  for (let pixel = 0; pixel < 16; pixel++) {
    const rgba = sourcePixel(pixel % 8, Math.floor(pixel / 8));
    const native = pixelFromBgra(cpu, pixel * 4);
    assert.deepEqual(native, rgba);
    const premultiplied = [...rgba.slice(0, 3).map(color => Math.round(color * rgba[3] / 255)), rgba[3]];
    if (rgba[3] < 255) assert.notDeepEqual(native, premultiplied, `pixel${pixel} discriminates multiplication by alpha`);
    if (rgba[3] > 0 && rgba[3] < 255 && Math.max(...native.slice(0, 3)) > native[3]) informative++;
  }
  assert.equal(informative, 10, "nonzero fractional alpha provides evidence beyond the special alpha0 case");
});

test("native texture observations follow successful INDEX16 references and exact shader bytes", () => {
  const expectedShaders = [
    [1568, "e64fbdfe1b009718514bcf6d4c8847c95c8d73f99755a355eef393782c43e298"],
    [224, "892079c3e951efd145857f72d707a235d73e2ea6dad93e123122f6de09e5ecaf"],
  ];
  assert.equal(runtime.observations.length, 2);
  for (const [ordinal, observation] of runtime.observations.entries()) {
    const { draw, indices, shader } = observation;
    assert.deepEqual(observation.capture.errors, []);
    assert.equal(observation.capture.detached, true);
    assert.equal(draw.originalDrawResult.signed, 0, "shader presence alone does not establish a successful source draw");
    assert.equal(draw.read, "original-CPU-writes-before-Unlock");
    assert.equal(draw.type, 4);
    assert.equal(draw.primitiveCount, 2);
    assert.equal(draw.stride, 48);
    assert.equal(indices.format, 101);
    const raw = Buffer.from(indices.littleEndianHex, "hex");
    assert.equal(raw.length, 12);
    const actualIndices = Array.from({ length: 6 }, (_, index) => raw.readUInt16LE(index * 2));
    assert.deepEqual(actualIndices, indices.values);
    assert.deepEqual(new Set(actualIndices.map(index => index + draw.baseVertex)),
      new Set(draw.selected.map(vertex => vertex.index)), "only referenced vertices may establish UV and COLOR0");
    assert.equal(draw.selected.length, 4);
    assert.ok(draw.declaration.some(entry => entry.stream === 0 && entry.type === 4 && entry.usage === 10 && entry.usageIndex === 0 && entry.offset === 12));
    assert.ok(draw.declaration.some(entry => entry.stream === 0 && entry.type === 1 && entry.usage === 5 && entry.usageIndex === 0 && entry.offset === 16));
    for (const vertex of draw.selected) {
      assert.equal(Number.parseInt(vertex.colorARGB, 16), 0xffffffff);
      assert.equal(vertex.alphaByte, 255, "fractional texture alpha is not a lowered parent/vertex opacity");
    }
    assert.deepEqual([shader.bytes, shader.sha256], expectedShaders[ordinal]);
    const bytecode = Buffer.from(shader.bytecodeHex, "hex");
    assert.equal(bytecode.length, shader.bytes);
    assert.equal(sha256(bytecode), shader.sha256);
    assert.equal(bytecode.readUInt32LE(0), 0xffff0300);
  }
});

test("all original texture content and one-pixel gutter retain straight source RGBA", () => {
  for (const observation of runtime.observations) {
    const { atlas } = observation;
    assert.equal(atlas.format, 21);
    assert.equal(atlas.width, 2048);
    assert.equal(atlas.height, 2048);
    assert.equal(atlas.pitch, 8192);
    assert.equal(atlas.fullSourceMatchCount, 1, "the entire two-row byte signature uniquely identifies source location");
    const patch = Buffer.from(atlas.regionBgraHex, "hex");
    assert.equal(patch.length, 10 * 4 * 4);
    assert.equal(sha256(patch), atlas.regionSha256);
    const [left, top, right, bottom] = atlas.contentRectExclusive;
    assert.equal(right - left, 8);
    assert.equal(bottom - top, 2);
    assert.deepEqual(atlas.regionRectExclusive, [left - 1, top - 1, right + 1, bottom + 1]);
    let content = 0, gutter = 0;
    for (let y = top - 1; y <= bottom; y++) for (let x = left - 1; x <= right; x++) {
      const sourceX = Math.max(0, Math.min(7, x - left));
      const sourceY = Math.max(0, Math.min(1, y - top));
      assert.deepEqual(atlasPixel(observation, x, y), sourcePixel(sourceX, sourceY),
        `native region(${x},${y}) must retain RGB and alpha, including all gutter sides/corners`);
      if (x >= left && x < right && y >= top && y < bottom) content++;
      else gutter++;
    }
    assert.equal(content, 16);
    assert.equal(gutter, 24);
  }
});

test("photo quad's actual inner crop stays within the identified source, and its edge samples use only source or duplicate gutter", () => {
  const photo = runtime.observations[0], plain = runtime.observations[1];
  assert.deepEqual(photo.atlas.contentRectExclusive, [1, 65, 9, 67]);
  assert.deepEqual(photo.uvTexelBounds, [2, 65, 8, 67]);
  assert.deepEqual(plain.atlas.contentRectExclusive, [1, 1, 9, 3]);
  assert.deepEqual(plain.uvTexelBounds, [1, 1, 9, 3]);
  for (const observation of runtime.observations) {
    const [left, top, right, bottom] = observation.atlas.contentRectExclusive;
    const coords = observation.draw.selected.map(vertex => [vertex.uv0[0] * observation.atlas.width, vertex.uv0[1] * observation.atlas.height]);
    for (const [u, v] of coords) {
      assert.ok(u >= left && u <= right && v >= top && v <= bottom);
      assert.equal(u, Math.round(u));
      assert.equal(v, Math.round(v));
    }
    assert.deepEqual([Math.min(...coords.map(([u]) => u)), Math.min(...coords.map(([, v]) => v)),
      Math.max(...coords.map(([u]) => u)), Math.max(...coords.map(([, v]) => v))], observation.uvTexelBounds);
    const [u0, v0, u1, v1] = observation.uvTexelBounds;
    for (const sx of [0, 0.02, 0.25, 0.5, 0.75, 0.98, 1]) for (const sy of [0, 0.02, 0.5, 0.98, 1]) {
      const u = u0 + (u1 - u0) * sx, v = v0 + (v1 - v0) * sy;
      const native = bilinear(u - 0.5, v - 0.5, (x, y) => atlasPixel(observation, x, y));
      const independentSource = bilinear(u - left - 0.5, v - top - 0.5,
        (x, y) => sourcePixel(Math.max(0, Math.min(7, x)), Math.max(0, Math.min(1, y))));
      for (let channel = 0; channel < 4; channel++) assert.ok(Math.abs(native[channel] - independentSource[channel]) < 1e-10);
    }
  }
  assert.notDeepEqual(photo.uvTexelBounds, photo.atlas.contentRectExclusive,
    "UV bounds are an observed 6x2 inner crop and cannot establish full source size or native gutter bounds");
});

test("readback preserves original state and records non-sRGB LINEAR sampling and alpha blend", () => {
  for (const observation of runtime.observations) {
    const { readback } = observation;
    assert.equal(readback.valid, true);
    assert.equal(readback.failure, null);
    assert.equal(readback.stateUnchanged, true);
    assert.equal(readback.gettersSucceeded, true);
    assert.deepEqual(readback.after, readback.before);
    for (const result of [...Object.values(readback.before.getterResults), ...Object.values(readback.before.renderStateResults),
      ...Object.values(readback.before.samplerResults)]) assert.equal(result, 0);
    for (const step of readback.steps) assert.equal(step.hresult, 0, step.name);
    assert.ok(readback.steps.some(step => step.name === "Device.GetRenderTargetData"));
    assert.ok(readback.steps.some(step => step.name === "OwnedSystemSurface.LockRect(READONLY)"));
    const { sampler0, renderStates } = readback.before;
    assert.deepEqual([sampler0[1], sampler0[2], sampler0[5], sampler0[6], sampler0[7], sampler0[11]], [3, 3, 2, 2, 0, 0]);
    assert.equal(renderStates[194], 0);
    assert.deepEqual([renderStates[19], renderStates[20], renderStates[27], renderStates[171]], [5, 6, 1, 1]);
    assert.deepEqual([renderStates[206], renderStates[207], renderStates[208], renderStates[209]], [1, 2, 2, 1]);
  }
});

test("controlled transparency evidence does not invent a natural artist service or a transparent PS324 input draw", () => {
  assert.equal(runtime.provenance.targetDllSha256, "1bccee7b3302810d86f2f230d584abfb945e689dc7f01a7a7e20be6853ead47f");
  assert.equal(runtime.provenance.naturallyLoadedArtistPhoto, false);
  assert.equal(runtime.provenance.userMusicCacheObserved, false);
  assert.equal(runtime.provenance.transparentCoverDrawObserved, false);
  assert.ok(runtime.provenance.excludedCoverInputReason.includes("zero atlas readbacks"));
  assert.ok(runtime.observations.every(observation => observation.shader.bytes !== 324));
});
