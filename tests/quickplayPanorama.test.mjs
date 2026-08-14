import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = [
  "src/app/podcastPlaybackSettings.ts",
  "src/hooks/useNavigation.ts",
  "src/hooks/useMusicLibrary.ts",
  "src/hooks/usePodcastPlayback.ts",
  "src/hooks/usePlaybackControls.ts",
  "src/hooks/useAudioEngine.ts",
  "src/hooks/usePlaylists.ts",
  "src/App.tsx",
].map((path) => readFileSync(path, "utf8")).join("\n");
const quickplaySource = readFileSync("src/views/QuickplayView.tsx", "utf8");
const quickplayBlocksSource = readFileSync("src/utils/quickplayBlocks.ts", "utf8");
const menuSource = readFileSync("src/components/ContextMenu.tsx", "utf8");
const quickplayCss = readFileSync("src/styles/quickplay.css", "utf8");

test("quickplay is a keyboard and mouse-wheel accessible horizontal panorama", () => {
  const quickplayRule = cssRule(quickplayCss, ".quickplay");
  const viewportRule = cssRule(quickplayCss, ".quickplay-viewport");
  assert.ok(quickplayRule.includes("overflow: hidden"), "the stable page layer clips the panorama");
  assert.ok(viewportRule.includes("overflow-x: auto"));
  assert.ok(viewportRule.includes("overflow-y: hidden"), "page stays a horizontal panorama, not a vertical page");
  assert.ok(viewportRule.includes("scroll-snap-type: none"));
  assert.ok(quickplaySource.includes('className="quickplay-viewport"'));
  assert.ok(quickplaySource.includes('window.addEventListener("wheel", handleWheel, { passive: false, capture: true })'));
  assert.ok(quickplaySource.includes("quick-section-scroll"), "dense sections own their vertical scrollports");
  assert.ok(quickplayCss.includes(".quick-section-scroll"), "section scroll styles exist");
  assert.ok(quickplaySource.includes("viewport.scrollLeft = nextScrollLeft"), "reduced motion keeps the direct jump");
  assert.ok(quickplaySource.includes("spring: SPRING_PRESETS.snappy"), "wheel pans ride the motion kernel spring for inertia");
  assert.ok(quickplaySource.includes("running.retarget(nextScrollLeft)"), "consecutive wheel ticks retarget the in-flight spring");
  assert.ok(quickplaySource.includes('window.removeEventListener("wheel", handleWheel, true);'));
  assert.ok(quickplaySource.includes("scrollAnimRef.current.handle?.cancel();"), "cleanup cancels the in-flight spring");
  assert.ok(quickplaySource.includes("}, [tracks.length, reducedMotion]);"));
  assert.ok(!quickplaySource.includes("handlePanoramaPointerDown"));
  assert.ok(!quickplaySource.includes("handlePanoramaPointerMove"));
  assert.ok(quickplaySource.includes("onKeyDown={handlePanoramaKey}"));
  assert.ok(quickplaySource.includes("quickplay-ghost"));
  assert.ok(!quickplaySource.includes("ghost.style.transform"), "ghost must not parallax with scrollLeft restore");
});

test("pin fronts carry a persistent title and the panorama keeps its pink wash", () => {
  // Pin names must be glanceable on the front — the back face only appears
  // after a 45-110s dwell and edit mode pauses flipping entirely.
  const frontTitleRule = cssRule(quickplayCss, ".quick-pin-front-title");
  assert.ok(frontTitleRule.includes("position: absolute"));
  assert.ok(frontTitleRule.includes("pointer-events: none"));
  assert.ok(quickplaySource.includes("quick-pin-front-title"));
  const quickplayRule = cssRule(quickplayCss, ".quickplay");
  assert.ok(quickplayRule.includes("radial-gradient"));
  assert.ok(quickplayCss.includes("rgba(128, 35, 76, 0.36)"));
  // The old hover play badge and caption band are gone from the DOM and CSS.
  assert.ok(!quickplaySource.includes("quick-pin-play"));
  assert.ok(!quickplayCss.includes(".quick-pin-play"));
  assert.ok(!quickplayCss.includes(".quick-pin-main"));
  assert.ok(!quickplayCss.includes(".quick-pin-caption"));
});

test("quickplay ghost stays stable through cold-start hydration and scroll restoration", () => {
  const quickplayRule = cssRule(quickplayCss, ".quickplay");
  const viewportRule = cssRule(quickplayCss, ".quickplay-viewport");
  assert.ok(quickplayRule.includes("quickplay-fade-in"));
  assert.ok(!quickplayRule.includes("motion-page-enter"), "page travel would drag the ghost mid-screen");
  assert.ok(quickplayCss.includes("@keyframes quickplay-fade-in"));
  const ghostRule = cssRule(quickplayCss, ".quickplay-ghost");
  assert.ok(ghostRule.includes("position: absolute"), "ghost is anchored to the stable page layer");
  assert.ok(!viewportRule.includes("animation:"), "the scroll owner does not carry page entrance motion");
  assert.ok(!quickplaySource.includes("if (tracks.length === 0) {"), "empty and hydrated states share one page root");
  assert.ok(!quickplaySource.includes("<h1>quickplay</h1>"), "library hydration must not replace a centered duplicate heading");
  const ghostIndex = quickplaySource.indexOf('<div className="quickplay-ghost"');
  const viewportIndex = quickplaySource.indexOf('className="quickplay-viewport"');
  assert.ok(ghostIndex >= 0 && ghostIndex < viewportIndex, "ghost stays outside and before the scroll viewport");
  assert.equal(quickplaySource.match(/quickplay-ghost/g)?.length, 1, "one ghost persists across empty and hydrated states");
});

test("pins title stays secondary to the continue stage", () => {
  const pinsTitle = cssRule(quickplayCss, ".quick-pins h2");
  assert.ok(pinsTitle.includes("clamp(42px, 4vw, 58px)"));
  assert.ok(!pinsTitle.includes("6.3vw"), "old oversized pins title must stay gone");
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

test("edit mode keeps the whole tile draggable instead of a nested button", () => {
  // In edit mode the artwork/caption surface must not be a nested <button>,
  // which would swallow the drag start and break tile reordering.
  assert.ok(quickplaySource.includes("draggable={editingPins}"));
  assert.ok(quickplaySource.includes("tabIndex={0}"), "edit-mode surface keeps keyboard Alt+arrow reorder");
  const editingTileRule = cssRule(quickplayCss, ".quick-pins-grid.editing .quick-pin");
  assert.ok(editingTileRule.includes("cursor: grab"));
  assert.ok(cssRule(quickplayCss, ".quick-pin.dragging").includes("cursor: grabbing"));
});

test("recent albums use persisted addition timestamps instead of alphabetical array position", () => {
  assert.ok(quickplayBlocksSource.includes("albumAddedAt(b, input.activity) - albumAddedAt(a, input.activity)"));
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
