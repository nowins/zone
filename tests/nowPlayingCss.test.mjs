import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const nowPlayingCss = readFileSync("src/styles/now-playing.css", "utf8");
const animationCss = readFileSync("src/styles/animations-responsive.css", "utf8");
const baseCss = readFileSync("src/styles/base.css", "utf8");
const nowPlayingView = readFileSync("src/views/NowPlayingView.tsx", "utf8");
const mosaicCanvasSource = readFileSync("src/components/NowPlayingMosaicCanvas.tsx", "utf8");

test("now playing visual layers are canvas based", () => {
  assert.ok(nowPlayingView.includes("<NowPlayingMosaicCanvas"));
  assert.ok(nowPlayingView.includes("<AudioGlowCanvas"));
  assert.ok(nowPlayingView.includes("beatPulse={beatPulse}"));
  assert.ok(nowPlayingView.includes("onsetStrength={onsetStrength}"));
  assert.ok(nowPlayingView.includes("beatConfidence={beatConfidence}"));
  assert.ok(!nowPlayingView.includes("wallTilePatternForIndex"), "DOM wall tile mapping should be removed from the view");
  assert.ok(!nowPlayingView.includes("visualizer-wave-svg"), "SVG visualizer should be removed from the view");

  const mosaicRule = cssRule(nowPlayingCss, ".now-mosaic-canvas");
  const glowRule = cssRule(nowPlayingCss, ".audio-glow-canvas");

  assert.ok(mosaicRule.includes("position: absolute"));
  assert.ok(mosaicRule.includes("inset: 0"));
  assert.ok(glowRule.includes("height: clamp(88px, 8vh, 122px)"));
  assert.ok(!glowRule.includes("22vh"));
  assert.ok(glowRule.includes("mix-blend-mode: screen"));
  assert.ok(!nowPlayingCss.includes(".album-wall"), "old DOM album wall styles should stay out of now playing CSS");
  assert.ok(!nowPlayingCss.includes(".visualizer-wave-svg"), "old SVG visualizer styles should stay out of now playing CSS");
});

test("now playing artwork is full bleed without a recording-frame inset", () => {
  const stageRule = cssRule(nowPlayingCss, ".now-playing-stage");

  assert.ok(stageRule.includes("height: 100%"));
  assert.ok(stageRule.includes("margin: 0"));
  assert.ok(stageRule.includes("border: 0"));
  assert.ok(stageRule.includes("box-shadow: none"));
});

test("chrome idle and immersive modes preserve the audio glow", () => {
  const idleGlowRule = cssRule(nowPlayingCss, ".chrome-idle .audio-glow-canvas");
  const immersiveGlowRule = cssRule(nowPlayingCss, ".chrome-immersive .audio-glow-canvas");
  const immersivePanelRule = cssRule(nowPlayingCss, ".chrome-immersive .now-side-panel");

  assert.ok(Number(idleGlowRule.match(/opacity:\s*([0-9.]+)/)?.[1]) >= 0.85);
  assert.ok(immersiveGlowRule.includes("opacity: 1"));
  assert.ok(immersivePanelRule.includes("pointer-events: none"));
  assert.ok(nowPlayingCss.includes(".chrome-immersive"));
});

test("track info keeps Zune-like left anchor hierarchy", () => {
  const trackCardRule = cssRule(nowPlayingCss, ".now-track-card");
  const coverRule = cssRule(nowPlayingCss, ".now-track-card .mini-cover");
  const artistRule = cssRule(nowPlayingCss, ".now-track-card strong");
  const albumRule = cssRuleLast(nowPlayingCss, ".now-track-card span");
  const titleRule = cssRuleLast(nowPlayingCss, ".now-track-card em");
  const copyRule = cssRule(nowPlayingCss, ".now-track-copy");

  assert.ok(trackCardRule.includes("--now-cover-size: clamp(128px, 10.5vw, 220px)"));
  assert.ok(trackCardRule.includes("grid-template-columns: var(--now-cover-size)"));
  assert.ok(coverRule.includes("width: var(--now-cover-size)"));
  assert.ok(coverRule.includes("height: var(--now-cover-size)"));
  assert.ok(coverRule.includes("outline: clamp(3px, 0.24vw, 5px) solid"));
  assert.ok(artistRule.includes("font-weight: 600"));
  assert.ok(artistRule.includes("text-transform: uppercase"));
  assert.ok(albumRule.includes("text-transform: uppercase"));
  assert.ok(copyRule.includes("display: flex"));
  assert.ok(copyRule.includes("flex-direction: column"));
  assert.ok(px(titleRule, "margin-top") >= 14, "song title should have breathing room from album metadata");
});

test("right status card and bottom progress remain separated", () => {
  const panelRule = cssRule(nowPlayingCss, ".now-side-panel");
  const trackListRule = cssRule(nowPlayingCss, ".now-panel-tracks");
  const controlsRule = cssRule(nowPlayingCss, ".now-panel-controls");
  const transportRule = cssRuleLast(nowPlayingCss, ".now-transport");
  const progressRule = cssRule(nowPlayingCss, ".now-progress");
  const glowRule = cssRule(nowPlayingCss, ".audio-glow-canvas");

  assert.ok(px(trackListRule, "max-height") <= 180, "right queue should stay compact by default");
  assert.ok(panelRule.includes("bottom: 0"));
  assert.ok(panelRule.includes("background: rgba(0, 0, 0, 0.58)"));
  assert.ok(controlsRule.includes("display: flex"));
  assert.ok(controlsRule.includes("justify-content: flex-end"));
  assert.ok(controlsRule.includes("width: 100%"));
  assert.ok(px(cssRule(nowPlayingCss, ".now-panel-controls button"), "width") >= 34);
  assert.ok(px(cssRule(nowPlayingCss, ".now-panel-controls .now-play"), "width") >= 48);
  assert.ok(transportRule.includes("bottom: 28px"));
  assert.ok(progressRule.includes("bottom: 0"));
  assert.ok(progressRule.includes("left: 50%"));
  assert.ok(progressRule.includes("width: clamp(270px, 24vw, 520px)"));
  assert.ok(px(glowRule, "max-height") <= 122, "glow should stay below the raised progress area");
});

test("mosaic canvas does not use audio energy for brightness", () => {
  assert.ok(!mosaicCanvasSource.includes("energyRef"));
  assert.ok(!mosaicCanvasSource.includes("createEnergyTint"));
  assert.ok(!/globalAlpha\s*=\s*[^;\n]*(energy|beatPulse)/.test(mosaicCanvasSource));
  assert.ok(!/brightness\([^)]*(energy|beatPulse)/.test(mosaicCanvasSource));
  assert.ok(mosaicCanvasSource.includes("createSlowTint"));
});

test("mosaic waits for decoded covers and reveals without text placeholders", () => {
  assert.ok(mosaicCanvasSource.includes("await preloadWallImages(wallAlbums)"));
  assert.ok(mosaicCanvasSource.includes("image.decode()"));
  assert.ok(mosaicCanvasSource.includes("wallRevealTargetRef.current = 1"));
  assert.ok(!mosaicCanvasSource.includes("fillText("), "album initials should never flash before covers decode");
  assert.ok(!mosaicCanvasSource.includes("initials("), "mosaic should not render text placeholders");
});

test("back button is restrained like the Zune chrome", () => {
  const backRule = cssRule(nowPlayingCss, ".now-back");
  const backRingRule = cssRule(nowPlayingCss, ".now-back::before");
  const nowPlayingTitlebarRule = cssRule(baseCss, ".shell-now-playing .titlebar");

  assert.ok(px(backRule, "width") >= 96, "back button needs a generous click target");
  assert.ok(px(backRule, "height") >= 96, "back button needs a generous click target");
  assert.ok(px(backRingRule, "width") <= 76, "visual ring should stay restrained inside the hit target");
  assert.ok(px(backRingRule, "border") <= 3);
  assert.ok(nowPlayingTitlebarRule.includes("pointer-events: none"), "titlebar must not intercept the back-button hit target");
  assert.ok(nowPlayingView.includes("strokeWidth={2.55}"));
});

test("save playlist dialog remains density-aware", () => {
  const dialogRule = cssRule(nowPlayingCss, ".save-playlist-dialog");
  const labelRule = cssRule(nowPlayingCss, ".save-playlist-dialog label span");

  assert.ok(px(dialogRule, "width") <= 440, "dialog should not balloon on scaled desktop displays");
  assert.ok(px(dialogRule, "min-height") <= 180);
  assert.ok(px(labelRule, "font-size") <= 34);
});

test("volume follows Zune's collapsed and hover-expanded pattern", () => {
  const volumeRule = cssRule(nowPlayingCss, ".now-volume");
  const inputRule = cssRule(nowPlayingCss, ".now-volume input");

  assert.ok(px(volumeRule, "width") <= 116, "idle volume control should only reserve room for its value");
  assert.ok(inputRule.includes("width: 0"));
  assert.ok(inputRule.includes("opacity: 0"));
  assert.ok(nowPlayingCss.includes(".now-volume:hover .now-volume-icon"));
  assert.ok(nowPlayingCss.includes("width: clamp(96px, 7.6vw, 142px)"));
  assert.ok(nowPlayingView.includes("<Volume2 className=\"now-volume-icon\""));
});

test("responsive rules no longer reference removed visualizer structures", () => {
  assert.ok(animationCss.includes(".now-mosaic-canvas"));
  assert.ok(animationCss.includes(".audio-glow-canvas"));
  assert.ok(!animationCss.includes(".wall-tile"));
  assert.ok(!animationCss.includes(".visualizer-wave-svg"));
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

function px(rule, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = rule.match(new RegExp(`${escaped}:\\s*(?:clamp\\()?([0-9.]+)px`));
  assert.ok(match, `missing px value for ${property}`);
  return Number(match[1]);
}
