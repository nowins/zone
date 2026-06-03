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
  const visualizerRule = cssRule(nowPlayingCss, ".visualizer");
  const lineRule = cssRule(nowPlayingCss, ".visualizer-line");
  const opacity = Number(idleRule.match(/opacity:\s*([0-9.]+)/)?.[1]);
  const height = Number(visualizerRule.match(/height:\s*([0-9.]+)px/)?.[1]);

  assert.ok(opacity >= 0.5, `idle visualizer opacity should remain visible, got ${opacity}`);
  assert.ok(nowPlayingCss.includes("opacity: 1;"), "visualizer parent should not multiply child opacity down");
  assert.ok(height <= 40, `visualizer should stay a low horizon, got ${height}px`);
  assert.ok(lineRule.includes("0.24 + var(--peak) * 0.18"), "visualizer line should stay low brightness");
});

test("now playing color wash and tile flip use slow Zune-like motion", () => {
  assert.ok(nowPlayingCss.includes("@property --cover-tint"));
  assert.ok(nowPlayingCss.includes("transition: --cover-tint 45s ease-in-out"));
  assert.ok(nowPlayingCss.includes("now-gradient-drift 180s"));
  assert.ok(nowPlayingCss.includes("now-gradient-sheen 260s"));
  assert.ok(animationCss.includes("rotateY(84deg)"), "tile flip should use a visible Y-axis turn");
  assert.ok(!cssKeyframes(animationCss, "wall-tile-flip").includes("scale("));
});

test("track info and queue match Zune-like static layout", () => {
  const ghostRule = cssRule(nowPlayingCss, ".now-type-ghost");
  const trackCardRule = cssRule(nowPlayingCss, ".now-track-card");
  const queueRule = cssRuleLast(nowPlayingCss, ".floating-queue");

  const ghostOpacity = Number(ghostRule.match(/opacity:\s*([0-9.]+)/)?.[1]);

  assert.ok(ghostOpacity <= 0.02, `ghost text should not be a primary visual layer, got ${ghostOpacity}`);
  assert.ok(trackCardRule.includes("grid-template-columns: 150px minmax(0, 360px)"));
  assert.ok(!trackCardRule.includes("44px"), "track card should not keep a third favorite column");
  assert.ok(queueRule.includes("background: rgba(0, 0, 0, 0.78)"));
  assert.ok(!queueRule.includes("linear-gradient"), "floating queue should be a dark panel, not a gradient list");
});

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[1];
}

function cssRuleLast(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...source.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g"))];
  assert.ok(matches.length > 0, `missing CSS rule ${selector}`);
  return matches.at(-1)[1];
}

function cssKeyframes(source, name) {
  const start = source.indexOf(`@keyframes ${name}`);
  assert.notEqual(start, -1, `missing keyframes ${name}`);
  const end = source.indexOf("@media", start);
  return source.slice(start, end === -1 ? undefined : end);
}
