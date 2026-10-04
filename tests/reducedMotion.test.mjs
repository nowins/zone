import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const motionCss = readFileSync("src/styles/motion.css", "utf8");
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
const presenceSource = readFileSync("src/motion/presence.tsx", "utf8");

// Reduced-motion exits must not leave a dead pause: CSS plays an 80ms
// opacity-only fade and the JS lifecycles wait the same instant tier.
test("reduced motion swaps spatial exits for an instant-tier opacity fade", () => {
  assert.ok(motionCss.includes("@keyframes motion-exit-reduced"));
  const reducedBlock = motionCss.slice(motionCss.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.ok(reducedBlock.includes("animation: motion-exit-reduced var(--motion-instant)"));
  // Presence exits retain a short fade; page navigation has no exit wait.
  assert.ok(reducedBlock.includes(".motion-exit .context-menu"));
  // Exit selectors must not sit in the animation:none kill list any more.
  const killList = reducedBlock.match(/animation:\s*none;/)?.[0];
  assert.ok(killList, "reduced block still kills entrance/feedback animations");
  const killRule = reducedBlock.slice(0, reducedBlock.indexOf("animation: none;"));
  assert.ok(!killRule.includes(".motion-exit .context-menu"), "context menu exit needs the fade, not a dead wait");
  assert.ok(motionCss.includes('.shell[data-page-motion="managed"]'));
  assert.ok(appSource.includes("if (reducedMotion) { pageMotion.current?.stop(); return; }"), "WAAPI motion stops as soon as the preference changes");
});

test("navigation commits immediately and Presence consumes the shared exit-duration policy", () => {
  assert.ok(appSource.includes("animate && !reducedMotion"));
  assert.ok(!readFileSync("src/hooks/useNavigation.ts", "utf8").includes("setTimeout"));
  assert.ok(presenceSource.includes("resolveExitDurationMs(exitDurationMs, reducedMotion)"));
});
