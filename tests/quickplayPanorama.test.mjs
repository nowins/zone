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
  assert.ok(quickplayRule.includes("overflow-x: auto"));
  assert.ok(quickplayRule.includes("scroll-snap-type: none"));
  assert.ok(quickplaySource.includes('window.addEventListener("wheel", handleWheel, { passive: false, capture: true })'));
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
});

test("quickplay pin play affordances are circular and the panorama keeps its pink wash", () => {
  const pinPlayRule = cssRule(quickplayCss, ".quick-pin-play");
  const quickplayRule = cssRule(quickplayCss, ".quickplay");
  assert.ok(pinPlayRule.includes("border-radius: 50%"));
  assert.ok(pinPlayRule.includes("border: 1px solid"));
  assert.ok(quickplayRule.includes("radial-gradient"));
  assert.ok(quickplayCss.includes("rgba(128, 35, 76, 0.36)"));
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
