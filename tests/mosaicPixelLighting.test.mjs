import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createMosaicLightingSampler, mosaicOverlay } from "../.tmp/visualizer-tests/utils/mosaicLighting.js";
import { executeIrisPixelShader, irisInstructionSlots, unpackIrisArgb } from "./helpers/irisPixelShader.mjs";

const runtime = JSON.parse(readFileSync(new URL("./fixtures/iris-runtime-pixel-shader.json", import.meta.url), "utf8"));
const { shader, sample } = runtime;
const CHANNELS = ["r", "g", "b"];
// Production uses the captured byte-space palette without cover gains.
const capturedPalette = ["c8", "c2", "c6"].map((name, index) => Object.fromEntries(
  CHANNELS.map((key, channel) => [key, sample.constantRegisters[name][channel] * 255]),
));
const capturedVertexColor = unpackIrisArgb(sample.cpuVertices.packedArgb[0]);

function nearColor(actual, expected, message, tolerance = 0.000005) {
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(Number.isFinite(actual[channel]) && Math.abs(actual[channel] - expected[channel]) < tolerance,
      `${message}, ${CHANNELS[channel]}: expected ${expected[channel]}, got ${actual[channel]}`);
  }
}

function controlledRegisters(width, height, dpi) {
  const registers = structuredClone(sample.constantRegisters);
  // The recorded moving positions are preserved in the fixture. Only these two
  // registers change for the documented time-zero path, not colors or radius.
  const [first, second] = runtime.controlledInputs.highlightPositionsNormalized;
  registers.c0 = [first[0] * width * dpi, first[1] * height * dpi, 0, 0];
  registers.c4 = [second[0] * width * dpi, second[1] * height * dpi, 0, 0];
  return registers;
}

test("runtime pixel fixture retains native registers, DEF constants and CPU-written white COLOR0", () => {
  assert.equal(shader.profile, "ps_3_0");
  assert.equal(shader.instructions.length, 62);
  assert.equal(irisInstructionSlots(shader), 64);
  assert.equal(shader.instructionSlots, 64);
  assert.equal(runtime.provenance.shaderSha256, "f4eb2bffdbfd4fc95d977b2251ed035a4fd50416cb8504a0b77392d4b3962ab5");
  assert.equal(runtime.provenance.captureSha256, "04d8ad2862ef72455e04a472ca71b3ff39f97cd523ae29ab5238d2fc2afeda60");
  assert.equal(sample.drawSeq, 17);
  assert.equal(sample.spGetDpi, 192);
  assert.equal(sample.cpuVertices.read, "original-CPU-writes-before-Unlock");
  assert.equal(sample.cpuVertices.stride, 48);
  assert.equal(sample.cpuVertices.colorOffset, 12);
  assert.equal(sample.cpuVertices.capturedCount, 8);
  assert.deepEqual(sample.cpuVertices.packedArgb, Array(8).fill(0xffffffff));
  assert.deepEqual(capturedVertexColor, [1, 1, 1, 1]);
  assert.deepEqual(unpackIrisArgb(0x80402010), [64, 32, 16, 128].map(value => value / 255));

  const bytes = Buffer.from(sample.cpuVertices.firstQuadBytes);
  const positions = [];
  for (let vertex = 0; vertex < 4; vertex++) {
    const offset = vertex * sample.cpuVertices.stride;
    positions.push([0, 4, 8].map(component => bytes.readFloatLE(offset + component)));
    assert.equal(bytes.readUInt32LE(offset + sample.cpuVertices.colorOffset), 0xffffffff);
  }
  assert.deepEqual(positions, [[0, 0, 0], [1921, 0, 0], [0, 1033, 0], [1921, 1033, 0]]);
  assert.deepEqual(runtime.coverage, {
    coreDraws: 60, cpuSnapshotDraws: 59, waitingDraws: 1, cpuSnapshotSeqRange: [17, 307],
    sampledCpuVertices: 472, sampledWhiteCpuVertices: 472,
    constantFloatsCompared: 2160, constantFloatDifferences: 0,
  });
  assert.deepEqual(sample.constantRegisters.c9, [0, 0, 0, 0]);
  assert.deepEqual(sample.constantRegisters.c10, [0, 0, 0, 0]);
  const evaluated = executeIrisPixelShader(shader, {
    constantRegisters: sample.constantRegisters, viewPosition: [1920, 1032], vertexColor: capturedVertexColor,
  });
  assert.deepEqual(evaluated.registers.c9, shader.defs.c9, "DEF is shader-local and overrides old API readback zeros");
  assert.deepEqual(evaluated.registers.c10, shader.defs.c10);
  assert.ok(evaluated.color.every(Number.isFinite));
  assert.ok(evaluated.color[3] > 1);
});

test("actual captured pixel constants produce full-strength alpha with the observed blend states", () => {
  assert.equal(sample.renderTargetFormat, 22);
  for (const [state, value] of [[19, 5], [20, 6], [27, 1], [171, 1], [194, 0],
    [206, 1], [207, 2], [208, 2], [209, 1]]) {
    assert.equal(sample.renderStates[state], value);
  }
  assert.deepEqual(sample.textures.map(texture => [texture.stage, texture.width, texture.height, texture.format]),
    [[0, 3840, 2064, 21], [1, 2048, 2048, 21]]);
  for (const texture of sample.textures) assert.equal(texture.sampler.find(state => state.state === 11).value, 0);
  for (const [x, y] of [[0, 0], [3840, 2064], [1920, 1032], sample.constantRegisters.c0.slice(0, 2),
    sample.constantRegisters.c4.slice(0, 2)]) {
    const output = executeIrisPixelShader(shader, {
      constantRegisters: sample.constantRegisters, viewPosition: [x, y], vertexColor: capturedVertexColor,
    }).color;
    assert.ok(output[3] >= 1.7619047, "the sampled white vertex adds no fixed .92 opacity reduction");
    assert.ok(output.slice(0, 3).every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1));
  }
});

test("production lighting and destination Overlay agree with captured PS instructions across full DPI scales", () => {
  const points = [[0, 0], [0.5, 0], [0.1, 1], [0.33, 0.47], [0.83, 0.21], [1, 1]];
  const destinations = [[0, 0.25, 1, 0], [0.25, 0.75, 0.5, 1], [0.5, 0.5, 0.5, 0.2],
    [0.499, 0.5, 0.501, 0.8], [0.9, 0.1, 0.65, 1]];
  for (const [width, height] of [[920, 620], [1180, 760], [1920, 1032]]) {
    for (const dpi of [1, 1.25, 2, 3]) {
      const lighting = createMosaicLightingSampler(capturedPalette, runtime.controlledInputs.timeSeconds, width, height, dpi);
      const registers = controlledRegisters(width, height, dpi);
      for (const [x, y] of points) {
        const field = lighting(x, y);
        for (const destination of destinations) {
          const output = executeIrisPixelShader(shader, {
            constantRegisters: registers, viewPosition: [x * width * dpi, y * height * dpi],
            vertexColor: capturedVertexColor, destinationColor: destination, imageColor: [1, 1, 1, 1],
          });
          // Production samples the inner field; its Overlay primitive then uses
          // Destination as base. The oracle executes the complete native PS.
          const actual = CHANNELS.map((channel, index) => mosaicOverlay(destination[index], field[channel] / 255) * 255);
          nearColor(actual, output.color.slice(0, 3).map(channel => channel * 255),
            `${width}x${height}, dpi${dpi}, point ${x},${y}, destination ${destination}`);
          assert.ok(output.color[3] >= 1, "full stable shader output remains opaque after UNORM clamping");
        }
      }
    }
  }
});

test("physical light radius retains DPI above the raster cap and does not stretch with viewport", () => {
  const point = [0.33, 0.47];
  const nativeAtThree = executeIrisPixelShader(shader, {
    constantRegisters: controlledRegisters(1180, 760, 3),
    viewPosition: [point[0] * 3540, point[1] * 2280], vertexColor: capturedVertexColor,
  }).color;
  const atThree = createMosaicLightingSampler(capturedPalette, 0, 1180, 760, 3)(...point);
  nearColor(CHANNELS.map(channel => atThree[channel]), nativeAtThree.slice(0, 3).map(channel => channel * 255), "DPI3 native physical radius");
  const samePhysicalViewport = createMosaicLightingSampler(capturedPalette, 0, 3540, 2280, 1)(...point);
  nearColor(CHANNELS.map(channel => samePhysicalViewport[channel]), CHANNELS.map(channel => atThree[channel]), "equal physical extents");
  const capped = createMosaicLightingSampler(capturedPalette, 0, 1180, 760, 2)(...point);
  assert.ok(CHANNELS.some(channel => Math.abs(capped[channel] - atThree[channel]) > 0.01), "DPI3 must not use capped raster DPR2");

  // A point 600 physical pixels away still receives light: Radius is a numerator,
  // not a hard cutoff and not a percentage of the viewport.
  const registers = controlledRegisters(1180, 760, 1);
  const near = executeIrisPixelShader(shader, {
    constantRegisters: registers, viewPosition: [registers.c0[0] + 600, registers.c0[1]],
  }).color;
  const removed = structuredClone(registers);
  removed.c1[0] = 0;
  const withoutFirstLight = executeIrisPixelShader(shader, {
    constantRegisters: removed, viewPosition: [registers.c0[0] + 600, registers.c0[1]],
  }).color;
  assert.ok(near.slice(0, 3).some((channel, index) => Math.abs(channel - withoutFirstLight[index]) > 0.0001));
});

test("captured shader samples Destination in the correct order and multiplies only final vertex RGBA", () => {
  const input = { constantRegisters: sample.constantRegisters, viewPosition: [1920, 1032],
    destinationColor: [0.25, 0.75, 0.5, 0.2], imageColor: [1, 1, 1, 0],
    destinationCoordinate: [0.8, 1.2, 4] };
  const reference = executeIrisPixelShader(shader, input);
  assert.deepEqual(reference.textureReads.map(read => read.sampler), ["s1", "s0"]);
  for (const [axis, expected] of [[0, 0.2], [1, 0.3]]) {
    assert.ok(Math.abs(reference.textureReads[1].coordinate[axis] - expected) < 1e-12,
      "Destination uses v3.xy/v3.z rather than ViewPos coordinates");
  }
  const differentTextureAlpha = executeIrisPixelShader(shader, {
    ...input, destinationColor: [...input.destinationColor.slice(0, 3), 1], imageColor: [1, 1, 1, 1],
  });
  assert.deepEqual(differentTextureAlpha.color, reference.color, "Source2 alpha excludes both sampled texture alphas");
  const vertexColor = [0.8, 0.6, 0.4, 0.2];
  const multiplied = executeIrisPixelShader(shader, { ...input, vertexColor }).color;
  for (let channel = 0; channel < 4; channel++) {
    assert.ok(Math.abs(multiplied[channel] - reference.color[channel] * vertexColor[channel]) < 1e-12);
  }
});
