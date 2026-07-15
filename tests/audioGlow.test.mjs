import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createZuneGlowFrame,
  createZuneMountainFrame,
} from "../.tmp/visualizer-tests/utils/audioGlow.js";

test("quiet Zune glow frame stays inactive", () => {
  const frame = createZuneGlowFrame({
    energy: 0,
    beatPulse: 0,
    onsetStrength: 0,
    beatPhase: 0.8,
    time: 4,
  });

  assert.equal(frame.active, false);
  assert.equal(frame.bodyAlpha, 0);
  assert.equal(frame.baseAlpha, 0);
  assert.equal(frame.hotspots.length, 0);

  const mountain = createZuneMountainFrame({
    samples: new Array(96).fill(0),
    energy: 0,
    beatPulse: 0,
    onsetStrength: 0,
    beatPhase: 1,
    time: 4,
  });
  assert.equal(mountain.ridgePoints.length, 0);
  assert.equal(mountain.ridgePeak, 0);
});

test("strong Zune glow stays low, central, and soft", () => {
  const frame = createZuneGlowFrame({
    energy: 0.82,
    beatPulse: 0.9,
    onsetStrength: 0.76,
    beatPhase: 0.04,
    time: 18,
  });

  assert.equal(frame.active, true);
  assert.ok(frame.visibleTop >= 0.55, `visible glow should start low in the canvas, got ${frame.visibleTop}`);
  assert.ok(frame.bodyHeight <= 0.4, `body should stay in the lower canvas band, got ${frame.bodyHeight}`);
  assert.ok(frame.bodyWidth >= 0.52 && frame.bodyWidth <= 0.62, `strong body width should match Zune central spread, got ${frame.bodyWidth}`);
  assert.ok(frame.centerIntensity > frame.edgeIntensity * 7, "center should be much stronger than the screen edges");
  assert.ok(frame.hotspots.length <= 5, "hotspots should stay sparse, not become a particle fountain");
});

test("ordinary playback Zune glow is visibly present", () => {
  const frame = createZuneGlowFrame({
    energy: 0.18,
    beatPulse: 0.05,
    onsetStrength: 0.02,
    beatPhase: 0.5,
    time: 11,
  });

  assert.equal(frame.active, true);
  assert.ok(frame.bodyWidth >= 0.32 && frame.bodyWidth <= 0.44, `ordinary glow should stay central, got ${frame.bodyWidth}`);
  assert.ok(frame.baseAlpha >= 0.14, `ordinary playback should have a visible dark red base, got ${frame.baseAlpha}`);
  assert.ok(frame.centerIntensity >= 0.34, `ordinary playback should be visible, got ${frame.centerIntensity}`);
  assert.ok(frame.visibleTop >= 0.62, `ordinary glow should remain low, got ${frame.visibleTop}`);
});

test("onset expands and brightens the glow without making it full width", () => {
  const calm = createZuneGlowFrame({
    energy: 0.28,
    beatPulse: 0.04,
    onsetStrength: 0.02,
    beatPhase: 0.6,
    time: 8,
  });
  const hit = createZuneGlowFrame({
    energy: 0.28,
    beatPulse: 0.82,
    onsetStrength: 0.86,
    beatPhase: 0.05,
    time: 8,
  });

  assert.ok(hit.bodyWidth > calm.bodyWidth, "strong onset should widen the central body");
  assert.ok(hit.bodyAlpha > calm.bodyAlpha, "strong onset should brighten the central body");
  assert.ok(hit.bodyWidth <= 0.62, "strong onset should not create a full-width red slab");
  assert.ok(hit.bodyLift > calm.bodyLift, "strong onset should only lift the body slightly");
});

test("mountain frame creates a full-width center-weighted ridge", () => {
  const samples = createMountainSamples(96, 0.5);
  const frame = createZuneMountainFrame({
    samples,
    energy: 0.46,
    beatPulse: 0.72,
    onsetStrength: 0.6,
    beatPhase: 0.08,
    time: 6,
  });
  const heights = frame.ridgePoints.map((point) => point.height);
  const center = average(heights.slice(40, 56));
  const edges = average([...heights.slice(0, 10), ...heights.slice(-10)]);

  assert.equal(frame.ridgePoints.length, 96);
  assert.ok(center > edges * 1.8, `center should remain the mountain body, center ${center}, edges ${edges}`);
  assert.ok(edges > 0.02, `edge extension should remain active, got ${edges}`);
  assert.ok(Math.max(...heights) - Math.min(...heights) > 0.08, "ridge should not be a flat breathing band");
  assert.ok(frame.ridgePeak <= 0.5, `ridge peak should stay restrained, got ${frame.ridgePeak}`);
});

test("different sample distributions change the mountain silhouette", () => {
  const left = createZuneMountainFrame({
    samples: createMountainSamples(96, 0.28),
    energy: 0.32,
    beatPulse: 0.12,
    onsetStrength: 0.08,
    beatPhase: 0.42,
    time: 4,
  });
  const right = createZuneMountainFrame({
    samples: createMountainSamples(96, 0.72),
    energy: 0.32,
    beatPulse: 0.12,
    onsetStrength: 0.08,
    beatPhase: 0.42,
    time: 4,
  });
  const leftBand = average(left.ridgePoints.slice(18, 36).map((point) => point.height));
  const rightBand = average(right.ridgePoints.slice(60, 78).map((point) => point.height));

  assert.ok(leftBand > average(right.ridgePoints.slice(18, 36).map((point) => point.height)) * 1.25);
  assert.ok(rightBand > average(left.ridgePoints.slice(60, 78).map((point) => point.height)) * 1.25);
});

test("onset raises mountain geometry instead of only changing alpha", () => {
  const samples = createMountainSamples(96, 0.5);
  const calm = createZuneMountainFrame({
    samples,
    energy: 0.28,
    beatPulse: 0.04,
    onsetStrength: 0.02,
    beatPhase: 0.6,
    time: 8,
  });
  const hit = createZuneMountainFrame({
    samples,
    energy: 0.28,
    beatPulse: 0.84,
    onsetStrength: 0.9,
    beatPhase: 0.04,
    time: 8,
  });

  assert.ok(hit.ridgePeak > calm.ridgePeak + 0.04, "strong onset should visibly raise the ridge");
  assert.ok(hit.ridgePeak <= 0.5);
});

test("AudioGlowCanvas renderer no longer uses a traditional path horizon", () => {
  const source = readFileSync("src/components/AudioGlowCanvas.tsx", "utf8");

  assert.ok(!source.includes("drawFlamePath"));
  assert.ok(source.includes("createZuneMountainFrame"));
  assert.ok(source.includes("drawMountainBody"));
  assert.ok(source.includes("quadraticCurveTo"));
  assert.ok(source.includes("createRadialGradient"));
  assert.ok(source.includes("source-over"));
});

function createMountainSamples(count, peakAt) {
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / Math.max(1, count - 1);
    const distance = (ratio - peakAt) / 0.13;
    return 0.028 + Math.exp(-distance * distance) * 0.28 + Math.sin(index * 0.61) * 0.012;
  });
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}
