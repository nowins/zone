import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const coverFlipSource = readFileSync("src/motion/coverFlip.ts", "utf8");
const playerBarSource = readFileSync("src/components/PlayerBar.tsx", "utf8");
const nowPlayingSource = readFileSync("src/views/NowPlayingView.tsx", "utf8");
const quickplaySource = readFileSync("src/views/QuickplayView.tsx", "utf8");
const playlistsCss = readFileSync("src/styles/playlists.css", "utf8");

test("cover flip clone is a fixed image flying above transient chrome", () => {
  assert.ok(coverFlipSource.includes('document.createElement("img")'));
  assert.ok(coverFlipSource.includes('style.position = "fixed"'));
  assert.ok(coverFlipSource.includes('style.pointerEvents = "none"'));
  assert.ok(coverFlipSource.includes("SPRING_PRESETS.snappy"), "landing should use the snappy spring");
  assert.ok(coverFlipSource.includes("computeFlipDelta(dock, source)"), "clone is laid out at the source and transforms onto the target");
  assert.ok(coverFlipSource.includes("getComputedStyle(target).borderRadius"));

  const cloneZ = Number(coverFlipSource.match(/CLONE_Z_INDEX = "(\d+)"/)[1]);
  const menuZ = Number(playlistsCss.match(/\.context-menu\s*\{[^}]*?z-index:\s*(\d+)/s)[1]);
  const toastZ = Number(playlistsCss.match(/\.action-toast\s*\{[^}]*?z-index:\s*(\d+)/s)[1]);
  assert.ok(cloneZ > menuZ, "clone must fly above the context menu");
  assert.ok(cloneZ > toastZ, "clone must fly above the action toast");
});

test("player bar registers the cover on open and flies it back on mount without a dock", () => {
  assert.ok(playerBarSource.includes("registerFlipElement(`cover:${track.id}`, coverButtonRef.current)"));
  assert.ok(playerBarSource.includes("onClick={handleOpenNowPlaying}"));
  assert.ok(playerBarSource.includes("onLabelClick={handleOpenNowPlaying}"));
  assert.ok(playerBarSource.includes("onQueue={handleOpenNowPlaying}"));
  assert.ok(playerBarSource.includes("takeFlipSource(`cover:${track.id}`)"));
  assert.ok(playerBarSource.includes("playCoverFlip({"));
  assert.ok(playerBarSource.includes("useReducedMotion"));
  assert.ok(!playerBarSource.includes("holdUntil"), "the return flight hands off as soon as it lands");
});

test("now playing consumes the flip source and docks through the card entrance", () => {
  assert.ok(nowPlayingSource.includes("takeFlipSource(`cover:${track.id}`)"));
  assert.ok(nowPlayingSource.includes('holdUntil: () => waitForCardAnimation(card, "end")'));
  assert.ok(nowPlayingSource.includes('revealTargetWhen: () => waitForCardAnimation(card, "start")'));
  assert.ok(nowPlayingSource.includes('COVER_FLIP_CARD_ANIMATIONS = ["now-track-info-enter", "now-track-card-fade"]'));
  assert.ok(nowPlayingSource.includes("COVER_FLIP_CARD_ANIMATIONS.includes(event.animationName)"), "the dock wait must accept both the plain entrance and the flip fade");
  assert.ok(nowPlayingSource.includes("setFlipCoverActive(true)"), "a live flight switches the card to its at-rest flip choreography");
  assert.ok(nowPlayingSource.includes('flipCoverActive ? "flip-cover-active" : ""'));
  assert.ok(nowPlayingSource.includes("COVER_FLIP_WAIT_TIMEOUT_MS = 2_500"), "the dock needs a bounded fallback");
  assert.ok(nowPlayingSource.includes("useReducedMotion"));
});

test("now playing registers the card cover on the way back", () => {
  assert.ok(nowPlayingSource.includes("registerFlipElement(`cover:${track.id}`, target)"));
  assert.ok(nowPlayingSource.includes("onClick={handleBack}"));
  assert.ok(nowPlayingSource.includes("trackCardRef"));
});

test("quickplay feature cover registers as a flip source only for the active track with real art", () => {
  assert.ok(quickplaySource.includes("handleFeatureCoverClick"));
  assert.ok(quickplaySource.includes("activeTrack.cover_path"));
  assert.ok(quickplaySource.includes("registerFlipElement(`cover:${activeTrack.id}`, cover)"));
});
