import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync("src/App.tsx", "utf8");
const quickplaySource = readFileSync("src/views/QuickplayView.tsx", "utf8");
const menuSource = readFileSync("src/components/ContextMenu.tsx", "utf8");
const quickplayCss = readFileSync("src/styles/quickplay.css", "utf8");

test("quickplay is a keyboard and wheel accessible horizontal panorama", () => {
  const quickplayRule = cssRule(quickplayCss, ".quickplay");
  assert.ok(quickplayRule.includes("overflow-x: auto"));
  assert.ok(quickplayRule.includes("scroll-snap-type: x proximity"));
  assert.ok(quickplaySource.includes("onWheel={handleWheel}"));
  assert.ok(quickplaySource.includes("onKeyDown={handlePanoramaKey}"));
  assert.ok(quickplaySource.includes("quickplay-ghost"));
});

test("home pins persist and support all durable collection entity types", () => {
  assert.ok(appSource.includes("setHomePins(normalizeHomePins(state.homePins))"));
  assert.ok(appSource.includes("homePins,"));
  assert.ok(quickplaySource.includes('pin.kind === "track"'));
  assert.ok(quickplaySource.includes('pin.kind === "album"'));
  assert.ok(quickplaySource.includes('pin.kind === "artist"'));
  assert.ok(quickplaySource.includes("resolvePlaylistTracks"));
  assert.ok(menuSource.includes("固定到 quickplay"));
  assert.ok(menuSource.includes("从 quickplay 取消固定"));
});

test("recent albums use persisted addition timestamps instead of alphabetical array position", () => {
  assert.ok(quickplaySource.includes("albumAddedAt(b, activity) - albumAddedAt(a, activity)"));
  assert.ok(!quickplaySource.includes("albums.slice(-6).reverse()"));
});

test("homepage redesign does not own bottom playback implementation", () => {
  assert.ok(!quickplaySource.includes("PlaybackProgress"));
  assert.ok(!quickplaySource.includes("TransportControls"));
  assert.ok(!quickplayCss.includes(".player"));
  assert.ok(!quickplayCss.includes(".zune-progress"));
});

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[1];
}
