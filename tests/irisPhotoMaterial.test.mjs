import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { executeIrisPixelShader, irisInstructionSlots, unpackIrisArgb } from "./helpers/irisPixelShader.mjs";

const runtime = JSON.parse(readFileSync(new URL("./fixtures/iris-runtime-photo-shader.json", import.meta.url), "utf8"));
const { shader, sample } = runtime;
const capturedColor = unpackIrisArgb(Buffer.from(sample.vertices.selected[0].hex, "hex").readUInt32LE(sample.colorDeclaration.offset));

function near(actual, expected, tolerance = 0.000001) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < tolerance, `expected ${expected}, got ${actual}`);
}

function evaluate(image, position = [493, 311], vertexColor = capturedColor, constants = sample.constantRegisters) {
  return executeIrisPixelShader(shader, { constantRegisters: constants, viewPosition: position,
    destinationColor: image, vertexColor, destinationCoordinate: [.37, .29, 1] });
}

function processedImage(image) {
  const gray = image[0] * .15 + image[1] * .55 + image[2] * .30;
  return image.slice(0, 3).map(channel => ((channel * .1 + gray * .9) - .5) * .95 + .5);
}

function overlay(base, source) { return base <= .5 ? 2 * base * source : 1 - 2 * (1 - base) * (1 - source); }

/** Direct effect graph reference, independent of the captured instruction order. */
function graphReference(image, position, vertexColor, registers = sample.constantRegisters) {
  const falloff = (origin, radius, attenuation) => {
    const distance = Math.hypot(position[0] - origin[0], position[1] - origin[1]);
    return Math.min(1, Math.max(0, radius[0] / (attenuation[0] + distance * attenuation[1] + distance * distance * attenuation[2])));
  };
  const first = falloff(registers.c0, registers.c1, registers.c3), second = falloff(registers.c4, registers.c5, registers.c7);
  const processed = processedImage(image);
  const fill = 800 / 1050;
  const rgb = processed.map((channel, index) => overlay(overlay(overlay(fill,
    registers.c2[index] * first), registers.c6[index] * second), channel * registers.c8[index]) * vertexColor[index]);
  const alpha = (fill + registers.c2[3] * first + registers.c6[3] * second + registers.c8[3]) * vertexColor[3];
  return [...rgb, alpha];
}

test("clean original PhotoClip fixture preserves PS1568, single image sampling and actual indexed white COLOR0", () => {
  assert.equal(runtime.provenance.captureSha256, "4944b96c1cab1f9c6c775f302a79d814ccffb4a8dac850235db411e1cd477b17");
  assert.equal(runtime.provenance.shaderSha256, "e64fbdfe1b009718514bcf6d4c8847c95c8d73f99755a355eef393782c43e298");
  assert.equal(runtime.provenance.shaderBytes, 1568);
  assert.deepEqual(runtime.provenance.cleanCapture, { errors: [], detached: true, detachedHooks: true });
  assert.equal(shader.profile, "ps_3_0");
  assert.equal(shader.instructions.length, 52);
  assert.equal(shader.instructionSlots, 54);
  assert.equal(irisInstructionSlots(shader), 54);
  assert.deepEqual(Object.entries(shader.constantBindings).filter(([, register]) => register.startsWith("s")), [["Sampler0", "s0"]]);
  assert.deepEqual(runtime.coverage, { materialDraws: 52, indexedCpuSnapshots: 51, waitingDraws: 1,
    selectedSeqRange: [19, 527], selectedVertices: 204, packedArgbCounts: { "0xffffffff": 204 },
    constantFloatsCompared: 1872, constantFloatDifferences: 0, drawResults: { "0": 52 }, uniqueVertexConstantPacks: 1 });
  assert.equal(sample.drawSeq, 19);
  assert.equal(sample.indices.format, 101);
  assert.equal(sample.indices.read, "original-CPU-writes-before-Unlock");
  assert.equal(sample.vertices.read, "original-CPU-writes-before-Unlock");
  assert.equal(sample.vertices.stride, 48);
  assert.equal(sample.colorDeclaration.offset, 12);
  assert.equal(sample.colorDeclaration.type, 4);
  const indices = Buffer.from(sample.indices.hex, "hex");
  const referenced = Array.from({ length: sample.indices.count }, (_, index) => indices.readUInt16LE(index * 2) + sample.vertices.baseVertexIndex);
  assert.deepEqual(referenced, [2, 0, 1, 1, 3, 2]);
  assert.deepEqual(new Set(referenced), new Set(sample.vertices.selected.map(vertex => vertex.index)));
  for (const vertex of sample.vertices.selected) {
    const bytes = Buffer.from(vertex.hex, "hex");
    assert.equal(bytes.length, 48);
    assert.equal(bytes.readUInt32LE(12), 0xffffffff);
  }
  assert.deepEqual(capturedColor, [1, 1, 1, 1]);
  assert.equal(runtime.vertexShader.instructions.at(-2), "mov o1, v1");
  assert.equal(runtime.vertexShader.instructions.at(-1), "mov o3.xy, v2");
  assert.deepEqual(sample.vertexConstants.slice(0, 16), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    "this controlled host uses identity WorldView even though SpGetDpi reports192");
  assert.deepEqual(sample.viewport, { width: 986, height: 622, x: 0, y: 0 });
});

test("LRP implements source1 weighting and source2 complement without hidden saturation", () => {
  const evaluated = executeIrisPixelShader({ defs: {}, instructions: ["lrp oC0, c0, c1, c2"] }, {
    constantRegisters: { c0: [.25, .5, .75, 1.5], c1: [1, 2, 3, 4], c2: [5, 6, 7, 8] }, viewPosition: [0, 0],
  });
  assert.deepEqual(evaluated.color, [4, 4, 4, 2]);
});

test("photo DEF overrides unused device banks and applies 90 percent gray with contrast .95", () => {
  assert.deepEqual(shader.defs.c10, [.150000006, .550000012, .300000012, .899999976]);
  assert.deepEqual(shader.defs.c11, [.949999988, .5, 0, 0]);
  for (const register of ["c9", "c10", "c11", "c12"]) assert.deepEqual(sample.constantRegisters[register], [0, 0, 0, 0]);
  const materialEnd = shader.instructions.indexOf("mad r3.xyz, r0, c11.x, c11.y") + 1;
  assert.ok(materialEnd > 0);
  const materialShader = { ...shader, instructions: shader.instructions.slice(0, materialEnd) };
  const inputs = [[0, 0, 0, 1], [1, 1, 1, 1], [1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1], [.5, .5, .5, 1]];
  const anchors = [[.025, .025, .025], [.975, .975, .975], [.24825, .15325, .15325],
    [.49525, .59025, .49525], [.2815, .2815, .3765], [.5, .5, .5]];
  inputs.forEach((image, index) => {
    const result = executeIrisPixelShader(materialShader, { constantRegisters: sample.constantRegisters,
      viewPosition: [493, 311], destinationColor: image });
    for (const register of ["c9", "c10", "c11", "c12"]) assert.deepEqual(result.registers[register], shader.defs[register]);
    result.registers.r3.slice(0, 3).forEach((channel, component) => {
      near(channel, anchors[index][component]);
      near(channel, processedImage(image)[component]);
    });
  });
});

test("captured registers agree with the image material and ordered Overlay tree over varied image colors", () => {
  let seed = 0x20261013;
  const positions = [[0, 0], [493, 311], [986, 622], sample.constantRegisters.c0.slice(0, 2), sample.constantRegisters.c4.slice(0, 2)];
  for (let index = 0; index < 128; index++) {
    const image = Array.from({ length: 4 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 24) / 255; });
    for (const position of positions) {
      const actual = evaluate(image, position);
      const expected = graphReference(image, position, capturedColor);
      actual.color.forEach((channel, component) => near(channel, expected[component]));
      assert.deepEqual(actual.textureReads.map(read => read.sampler), ["s0"], "there is no destination snapshot sampler in this photo PS");
      assert.deepEqual(actual.textureReads[0].coordinate.slice(0, 2), [.37, .29]);
    }
  }
});

test("photo Multiply chooses Primary alpha and discards sampled image alpha without changing RGB", () => {
  const color = [.83, .17, .61];
  const reference = evaluate([...color, 1]);
  for (const alpha of [0, 1 / 255, .25, .5, 1]) assert.deepEqual(evaluate([...color, alpha]).color, reference.color);
  const changed = structuredClone(sample.constantRegisters);
  changed.c8[3] = .37;
  const result = evaluate([...color, 0], [493, 311], capturedColor, changed).color;
  result.slice(0, 3).forEach((channel, component) => near(channel, reference.color[component]));
  near(result[3], reference.color[3] - .63);
  assert.equal(sample.constantRegisters.c2[3], 1);
  assert.equal(sample.constantRegisters.c6[3], 1);
  assert.equal(sample.constantRegisters.c8[3], 1);
});

test("final VertexRGBA multiplies accumulated photo output before framebuffer saturation", () => {
  const image = [.9, .3, .6, 0], position = [493, 311];
  const full = evaluate(image, position).color;
  assert.ok(full[3] > 1, "the original PS does not saturate its accumulated alpha");
  const tint = unpackIrisArgb(0x404080bf);
  const tinted = evaluate(image, position, tint).color;
  tinted.forEach((channel, component) => near(channel, full[component] * tint[component], 1e-12));
  assert.ok(tinted[3] > tint[3] && tinted[3] < 1,
    "clamping Field.a before multiplying vertex alpha would incorrectly equal Vertex.a");
  const zero = evaluate(image, position, [0, 0, 0, 0]).color;
  assert.deepEqual(zero, [0, 0, 0, 0]);
  assert.equal(shader.instructions.at(-1), "mul oC0, r0, v1");
});

test("observed photo draw uses normal RGB source alpha, separate alpha addition and encoded-channel sampling", () => {
  for (const [state, value] of [[19, 5], [20, 6], [27, 1], [171, 1], [194, 0],
    [206, 1], [207, 2], [208, 2], [209, 1]]) assert.equal(sample.renderStates[state], value);
  assert.deepEqual(sample.textures.map(texture => [texture.stage, texture.width, texture.height, texture.format]), [[0, 924, 693, 21]]);
  const sampler = Object.fromEntries(sample.textures[0].sampler.map(entry => [entry.state, entry.value]));
  assert.deepEqual(sampler, { 1: 3, 2: 3, 3: 1, 5: 2, 6: 2, 7: 0, 11: 0 });
  assert.equal(sample.renderTarget.format, 22);
  assert.equal(sample.renderTarget.width, 986);
  assert.equal(sample.renderTarget.height, 622);
  assert.equal(sample.result, 0);
});
