import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const nowPlayingCss = readFileSync("src/styles/now-playing.css", "utf8");
const animationCss = readFileSync("src/styles/animations-responsive.css", "utf8");

test("wall tiles fill their grid area without aspect ratio overflow", () => {
  const wallTileRule = cssRule(nowPlayingCss, ".wall-tile");

  assert.ok(wallTileRule.includes("width: 100%"));
  assert.ok(wallTileRule.includes("height: 100%"));
  assert.ok(!wallTileRule.includes("aspect-ratio"), "wall tiles should not force square boxes over rectangular spans");
  assert.ok(!nowPlayingCss.includes(".wall-tile-0"), "tile span classes should stay out of CSS");
});

test("visualizer remains visible when chrome is idle", () => {
  const idleRule = cssRule(nowPlayingCss, ".chrome-idle .visualizer");
  const opacity = Number(idleRule.match(/opacity:\s*([0-9.]+)/)?.[1]);

  assert.ok(opacity >= 0.5, `idle visualizer opacity should remain visible, got ${opacity}`);
  assert.ok(nowPlayingCss.includes("opacity: 1;"), "visualizer parent should not multiply child opacity down");
});

test("now playing color wash and tile flip use slow Zune-like motion", () => {
  assert.ok(nowPlayingCss.includes("@property --cover-tint"));
  assert.ok(nowPlayingCss.includes("transition: --cover-tint 45s ease-in-out"));
  assert.ok(nowPlayingCss.includes("now-gradient-drift 180s"));
  assert.ok(nowPlayingCss.includes("now-gradient-sheen 260s"));
  assert.ok(animationCss.includes("rotateY(84deg)"), "tile flip should use a visible Y-axis turn");
  assert.ok(!cssKeyframes(animationCss, "wall-tile-flip").includes("scale("));
});

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[1];
}

function cssKeyframes(source, name) {
  const start = source.indexOf(`@keyframes ${name}`);
  assert.notEqual(start, -1, `missing keyframes ${name}`);
  const end = source.indexOf("@media", start);
  return source.slice(start, end === -1 ? undefined : end);
}
