import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const coverFlipSource = readFileSync("src/motion/coverFlip.ts", "utf8");
const playerBarSource = readFileSync("src/components/PlayerBar.tsx", "utf8");
const nowPlayingSource = readFileSync("src/views/NowPlayingView.tsx", "utf8");
const quickplaySource = readFileSync("src/views/QuickplayView.tsx", "utf8");
const playlistsCss = readFileSync("src/styles/playlists.css", "utf8");
const animationCss = readFileSync("src/styles/animations-responsive.css", "utf8");

test("cover snapshot flies above transient chrome without intercepting input", () => {
  assert.ok(coverFlipSource.includes('style.position = "fixed"'));
  assert.ok(coverFlipSource.includes('style.pointerEvents = "none"'));
  assert.ok(coverFlipSource.includes('clone.setAttribute("aria-hidden", "true")'));
  const cloneZ = Number(coverFlipSource.match(/CLONE_Z_INDEX = "(\d+)"/)[1]);
  const menuZ = Number(playlistsCss.match(/\.context-menu\s*\{[^}]*?z-index:\s*(\d+)/s)[1]);
  const toastZ = Number(playlistsCss.match(/\.action-toast\s*\{[^}]*?z-index:\s*(\d+)/s)[1]);
  assert.ok(cloneZ > menuZ && cloneZ > toastZ);
});

test("all player bar entry actions capture decoded cover art and mount attaches the ongoing return", () => {
  assert.ok(playerBarSource.includes("registerCoverFlipSource(`cover:${track.id}`, coverButtonRef.current)"));
  assert.ok(playerBarSource.includes("onClick={handleOpenNowPlaying}"));
  assert.ok(playerBarSource.includes("onLabelClick={handleOpenNowPlaying}"));
  assert.ok(playerBarSource.includes("onQueue={handleOpenNowPlaying}"));
  assert.ok(playerBarSource.includes("rememberCoverReturnTarget(target)"));
  assert.ok(playerBarSource.includes("attachCoverReturn(`cover:${track.id}`, target)"));
  assert.ok(playerBarSource.includes("useReducedMotion"));
});

test("now playing overlaps the copy reveal with its flight and returns before navigation", () => {
  assert.ok(nowPlayingSource.includes("takeFlipSource(`cover:${track.id}`)"));
  assert.ok(nowPlayingSource.includes("setFlipCoverActive(Boolean(flip))"));
  assert.ok(nowPlayingSource.includes('flipCoverActive ? "flip-cover-active" : ""'));
  const back = nowPlayingSource.match(/function handleBack\(\) \{([\s\S]*?)\n  \}/)[1];
  const flight = back.indexOf("startCoverReturn(`cover:${track.id}`, target)");
  assert.ok(flight >= 0 && flight < back.indexOf("onBack()"));
  assert.ok(animationCss.includes(".stage-entering.flip-cover-active .now-track-copy"));
  assert.ok(animationCss.includes("var(--motion-coverInfo) var(--motion-coverInfoDelay)"));
  assert.ok(!animationCss.includes("flip-docked"), "text must not wait for a dock event");
  assert.ok(nowPlayingSource.includes("useReducedMotion"));
});

test("quickplay captures only the live music cover with real artwork", () => {
  assert.ok(quickplaySource.includes("handleContinueActivate"));
  assert.ok(quickplaySource.includes("continueTrack.cover_path"));
  assert.ok(quickplaySource.includes("registerCoverFlipSource(`cover:${continueTrack.id}`, cover)"));
});
