import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MOSAIC_COVER_MATERIAL, applyMosaicCoverMaterial } from "../.tmp/visualizer-tests/utils/mosaicCoverMaterial.js";
import { executeIrisPixelShader, irisInstructionSlots, unpackIrisArgb } from "./helpers/irisPixelShader.mjs";

const runtime = JSON.parse(readFileSync(new URL("./fixtures/iris-runtime-cover-shader.json", import.meta.url), "utf8"));
const { shader, sample } = runtime;
const vertexColors = sample.vertices.selected.map(vertex => unpackIrisArgb(Buffer.from(vertex.data).readUInt32LE(sample.colorDeclaration.offset)));

function evaluateCover(pixel, vertexColor = vertexColors[0]) {
  return executeIrisPixelShader(shader, {
    constantRegisters: sample.constantRegisters,
    viewPosition: [0.25, 0.75],
    // Sampler0 is the source cover in PS324, rather than the destination
    // snapshot used by the separate lighting PS1728.
    destinationColor: pixel.map(channel => channel / 255),
    vertexColor,
  });
}

function shaderOverBlack(pixel) {
  assert.equal(sample.renderStates[19], 5, "captured framebuffer source factor is SRCALPHA");
  assert.equal(sample.renderStates[20], 6, "captured destination factor is INVSRCALPHA");
  const { color } = evaluateCover(pixel);
  const sourceFactor = Math.min(1, Math.max(0, color[3]));
  const result = new Uint8ClampedArray(4);
  for (let channel = 0; channel < 3; channel++) {
    result[channel] = color[channel] * sourceFactor * 255;
  }
  result[3] = 255;
  return [...result];
}

function materialFor(source) {
  const pixels = new Uint8ClampedArray(source.flat());
  applyMosaicCoverMaterial(pixels);
  return Array.from({ length: source.length }, (_, pixel) => [...pixels.subarray(pixel * 4, pixel * 4 + 4)]);
}

test("cover fixture follows actual INDEX16 references to four alpha89 COLOR0 vertices", () => {
  assert.equal(runtime.provenance.captureSha256, "6022746823f00264bdd0c8fbeee4ffaea1757ab712bce7e7a652b6b513f1164e");
  assert.equal(runtime.provenance.shaderSha256, "8d0211079b68e15e071d5b37fd3c0fc0c0d576bdb55d5f88f1387fd33b0c6ad8");
  assert.equal(runtime.provenance.shaderBytes, 324);
  assert.equal(shader.instructions.length, 5);
  assert.equal(irisInstructionSlots(shader), 5);
  assert.equal(shader.profile, "ps_3_0");
  assert.equal(sample.drawSeq, 20);
  assert.equal(sample.indices.format, 101);
  assert.equal(sample.vertices.read, "original-CPU-writes-before-Unlock");
  assert.equal(sample.colorDeclaration.offset, 12);
  assert.equal(sample.colorDeclaration.type, 4);
  assert.equal(sample.vertices.stride, 48);
  assert.equal(sample.vertices.selected.length, 4);
  assert.equal(sample.vertices.referencedVertexCount, 4);
  const rawIndices = Buffer.from(sample.indices.data);
  const indices = Array.from({ length: sample.indices.count }, (_, index) => rawIndices.readUInt16LE(index * 2));
  assert.deepEqual(indices, sample.indices.values);
  assert.deepEqual(new Set(indices.map(index => index + sample.vertices.baseVertexIndex)),
    new Set(sample.vertices.selected.map(vertex => vertex.index)), "unreferenced leading VB bytes cannot establish material alpha");
  for (const vertex of sample.vertices.selected) {
    assert.equal(vertex.data.length, sample.vertices.stride);
    assert.equal(Buffer.from(vertex.data).readUInt32LE(sample.colorDeclaration.offset), 0x59ffffff);
  }
  assert.deepEqual(vertexColors, Array.from({ length: 4 }, () => [1, 1, 1, 89 / 255]));
  assert.deepEqual(runtime.coverage, {
    materialDraws: 55, indexedCpuSnapshots: 54, waitingDraws: 1,
    selectedSeqRange: [20, 936], selectedVertices: 216, packedArgbCounts: { "0x59ffffff": 216 },
  });
  assert.equal(MOSAIC_COVER_MATERIAL.opacity, vertexColors[0][3]);
  assert.deepEqual(MOSAIC_COVER_MATERIAL.weights, [0.15, 0.55, 0.30]);
  assert.equal(MOSAIC_COVER_MATERIAL.contrast, 0.85);
});

test("shader-local DEF supplies gray and contrast while API c0/c1 retain irrelevant old bank values", () => {
  assert.deepEqual(sample.constantRegisters.c0, [0, 0, 0, 1]);
  assert.deepEqual(sample.constantRegisters.c1, [500, 0, 0, 0]);
  assert.deepEqual(shader.defs.c0, [0.150000006, 0.550000012, 0.300000012, -0.5]);
  assert.deepEqual(shader.defs.c1, [0.850000024, 0.5, 0, 0]);
  const evaluation = evaluateCover([240, 30, 128, 255]);
  assert.deepEqual(evaluation.registers.c0, shader.defs.c0);
  assert.deepEqual(evaluation.registers.c1, shader.defs.c1);
  assert.deepEqual(evaluation.textureReads.map(read => read.sampler), ["s0"]);
  assert.equal(evaluation.color[0], evaluation.color[1]);
  assert.equal(evaluation.color[1], evaluation.color[2]);
  assert.equal(evaluation.color[3], 89 / 255, "RGB gray/contrast must not overwrite sampled alpha");
});

test("opaque black, white and RGB primaries match the native PS and black CellPanel blend", () => {
  const source = [[0, 0, 0, 255], [255, 255, 255, 255], [255, 0, 0, 255],
    [0, 255, 0, 255], [0, 0, 255, 255], [128, 128, 128, 255], [240, 30, 128, 255]];
  const result = materialFor(source);
  assert.deepEqual(result, source.map(shaderOverBlack));
  // Independent byte anchors expose added brightness or applying opacity twice.
  assert.deepEqual(result.slice(0, 5), [[7, 7, 7, 255], [82, 82, 82, 255],
    [18, 18, 18, 255], [48, 48, 48, 255], [29, 29, 29, 255]]);
});

test("source alpha survives the PS before precomposition and transparent RGB becomes opaque black", () => {
  const source = [0, 1, 2, 32, 64, 89, 128, 192, 254, 255]
    .flatMap(alpha => [[255, 255, 255, alpha], [255, 0, 0, alpha], [32, 170, 240, alpha], [0, 0, 0, alpha]]);
  assert.deepEqual(materialFor(source), source.map(shaderOverBlack));
  assert.deepEqual(materialFor([[255, 17, 240, 0], [0, 0, 0, 0]]), [[0, 0, 0, 255], [0, 0, 0, 255]]);
  const white = materialFor([[255, 255, 255, 128], [255, 255, 255, 255]]);
  assert.deepEqual(white, [[41, 41, 41, 255], [82, 82, 82, 255]], "precomposition keeps one opacity factor and stores opaque tile pixels");
  for (const alpha of [0, 64, 128, 255]) {
    assert.ok(Math.abs(evaluateCover([255, 0, 255, alpha]).color[3] - alpha / 255 * 89 / 255) < 1e-15);
  }
});

test("material processing mutates only the supplied pixel view while the original color source remains available", () => {
  const original = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0]);
  const originalBytes = [...original];
  const copy = original.slice();
  const identity = copy.buffer;
  applyMosaicCoverMaterial(copy);
  assert.equal(copy.buffer, identity);
  assert.deepEqual([...original], originalBytes, "the caller's cached color cover is not the material buffer");
  assert.deepEqual([...copy], materialFor([[255, 0, 0, 255], [0, 255, 0, 128], [0, 0, 255, 0]]).flat());

  const backing = new Uint8ClampedArray([11, 22, 33, 44, ...originalBytes, 55, 66, 77, 88]);
  const view = backing.subarray(4, 16);
  applyMosaicCoverMaterial(view);
  assert.deepEqual([...view], [...copy]);
  assert.deepEqual([...backing.subarray(0, 4)], [11, 22, 33, 44]);
  assert.deepEqual([...backing.subarray(16)], [55, 66, 77, 88]);
  const empty = new Uint8ClampedArray();
  applyMosaicCoverMaterial(empty);
  assert.equal(empty.length, 0);
});

test("bounded varied-color batch agrees with independent PS instruction evaluation within byte quantization", () => {
  let seed = 0x20261013;
  const source = Array.from({ length: 512 }, () => Array.from({ length: 4 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 24;
  }));
  const original = new Uint8ClampedArray(source.flat());
  const processed = original.slice();
  applyMosaicCoverMaterial(processed);
  for (let pixel = 0; pixel < source.length; pixel++) {
    const expected = shaderOverBlack(source[pixel]);
    for (let channel = 0; channel < 3; channel++) {
      // Native DEF floats differ by a few ULPs from the product's decimal
      // weights; an exact half-byte can round to either adjacent byte.
      assert.ok(Math.abs(processed[pixel * 4 + channel] - expected[channel]) <= 1,
        `pixel${pixel} channel${channel}: expected ${expected[channel]}, got ${processed[pixel * 4 + channel]}`);
    }
    assert.equal(processed[pixel * 4 + 3], 255, "each cached material is opaque before external UI alpha");
  }
  assert.deepEqual([...original], source.flat());
});
