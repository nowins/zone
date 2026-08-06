import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const tileSource = readFileSync("src/components/tiles/Tile.tsx", "utf8");
const flipSource = readFileSync("src/components/tiles/FlipTile.tsx", "utf8");
const indexSource = readFileSync("src/components/tiles/index.ts", "utf8");
const tilesCss = readFileSync("src/styles/tiles.css", "utf8");
const stylesEntry = readFileSync("src/styles.css", "utf8");
const quickplaySource = readFileSync("src/views/QuickplayView.tsx", "utf8");

test("tile system is a self-contained reusable component surface", () => {
  assert.ok(indexSource.includes("export { Tile }"));
  assert.ok(indexSource.includes("export { FlipTile }"));
  assert.ok(stylesEntry.includes("tiles.css"), "tiles stylesheet must be wired into the bundle");
  // Tiles reach into shared motion/utils with a stable relative depth.
  assert.ok(tileSource.includes("../../motion/useReducedMotion"));
  assert.ok(flipSource.includes("../../motion/animate"));
});

test("base tile carries the WP7 tilt press and hard clipping", () => {
  assert.ok(tileSource.includes("tiltPressDown"));
  assert.ok(tileSource.includes("tiltPressClear"));
  assert.ok(tilesCss.includes("overflow: hidden"));
  assert.ok(tilesCss.includes(".tile.tilt-pressed"));
});

test("flip tile flips on a jittered cadence and converges under reduced motion", () => {
  // Each tile picks its own jittered interval so a wall drifts out of phase.
  assert.ok(flipSource.includes("MIN_INTERVAL_MS"));
  assert.ok(flipSource.includes("Math.random()"));
  // Half-flip driven per-frame through a CSS variable, not a plain CSS loop.
  assert.ok(flipSource.includes("--tile-flip"));
  assert.ok(flipSource.includes("animateValue"));
  // Reduced motion swaps rotation for a cross-fade.
  assert.ok(tilesCss.includes("prefers-reduced-motion"));
  assert.ok(/opacity:\s*0/.test(tilesCss));
});

test("quickplay pins are built on the shared FlipTile", () => {
  assert.ok(quickplaySource.includes('from "../components/tiles"'));
  assert.ok(quickplaySource.includes("<FlipTile"));
  assert.ok(quickplaySource.includes("paused={editingPins}"));
});
