import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const nowPlayingCss = readFileSync("src/styles/now-playing.css", "utf8");
const playerCss = readFileSync("src/styles/player.css", "utf8");
const animationCss = readFileSync("src/styles/animations-responsive.css", "utf8");
const motionCss = readFileSync("src/styles/motion.css", "utf8");
const baseCss = readFileSync("src/styles/base.css", "utf8");
const nowPlayingView = readFileSync("src/views/NowPlayingView.tsx", "utf8");
const playerBarView = readFileSync("src/components/PlayerBar.tsx", "utf8");
const playbackProgressView = readFileSync("src/components/PlaybackProgress.tsx", "utf8");
const mosaicCanvasSource = readFileSync("src/components/NowPlayingMosaicCanvas.tsx", "utf8");
const audioGlowCanvasSource = readFileSync("src/components/AudioGlowCanvas.tsx", "utf8");
const lyricsSource = readFileSync("src/components/LyricsStage.tsx", "utf8");
const lyricsPaintLoopSource = readFileSync("src/components/lyricsStage/useLyricsPaintLoop.ts", "utf8");
const lyricsSourceBrowserSource = readFileSync("src/components/lyricsStage/LyricsSourceBrowser.tsx", "utf8");
const lyricsHookSource = readFileSync("src/hooks/useLyrics.ts", "utf8");
const lyricsCss = readFileSync("src/styles/lyrics.css", "utf8");

test("now playing visual layers are canvas based", () => {
  assert.ok(nowPlayingView.includes("<NowPlayingMosaicCanvas"));
  assert.ok(nowPlayingView.includes("<AudioGlowCanvas"));
  assert.ok(mosaicCanvasSource.includes("getVisualizerFrame"), "mosaic canvas should pull frames from the visualizer bus");
  assert.ok(audioGlowCanvasSource.includes("getVisualizerFrame"), "glow canvas should pull frames from the visualizer bus");
  assert.ok(!nowPlayingView.includes("beatPulse={beatPulse}"), "per-frame beat props should not flow through React");
  assert.ok(!nowPlayingView.includes("onsetStrength={onsetStrength}"), "per-frame beat props should not flow through React");
  assert.ok(!nowPlayingView.includes("beatConfidence={beatConfidence}"), "per-frame beat props should not flow through React");
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

test("chrome hides directly after idle without an intermediate dimmed state", () => {
  const immersiveGlowRule = cssRule(nowPlayingCss, ".chrome-immersive .audio-glow-canvas");
  const immersivePanelRule = cssRule(nowPlayingCss, ".chrome-immersive .now-side-panel");
  const immersiveTransportRule = cssRule(nowPlayingCss, ".chrome-immersive .now-back,\n.chrome-immersive .now-transport");

  assert.ok(!nowPlayingCss.includes(".chrome-idle"), "the dimmed intermediate chrome state should be removed");
  assert.ok(!nowPlayingView.includes("chromeMode(\"active\" | \"idle\""), "chrome should go straight from active to hidden");
  assert.ok(immersiveGlowRule.includes("opacity: 1"));
  assert.ok(immersivePanelRule.includes("opacity: 0"));
  assert.ok(immersivePanelRule.includes("pointer-events: none"));
  assert.ok(immersiveTransportRule.includes("opacity: 0"));
  assert.ok(nowPlayingView.includes("const IDLE_CHROME_DELAY = 5_000"));
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
  assert.ok(trackCardRule.includes("width: min(600px, 58vw)"));
  assert.ok(coverRule.includes("width: var(--now-cover-size)"));
  assert.ok(coverRule.includes("height: var(--now-cover-size)"));
  assert.ok(coverRule.includes("outline: clamp(3px, 0.24vw, 5px) solid"));
  assert.ok(artistRule.includes("font-weight: 600"));
  assert.ok(artistRule.includes("text-transform: uppercase"));
  assert.ok(albumRule.includes("text-transform: uppercase"));
  assert.ok(copyRule.includes("display: flex"));
  assert.ok(copyRule.includes("flex-direction: column"));
  assert.ok(copyRule.includes("overflow: hidden"));
  assert.ok(titleRule.includes("width: 100%"));
  assert.ok(titleRule.includes("text-overflow: ellipsis"));
  assert.ok(px(titleRule, "margin-top") >= 14, "song title should have breathing room from album metadata");
});

test("queue and shared bottom controls follow the compact Zune layout", () => {
  const panelRule = cssRule(nowPlayingCss, ".now-side-panel");
  const trackListRule = cssRule(nowPlayingCss, ".now-panel-tracks");
  const expandedPanelRule = cssRule(nowPlayingCss, ".now-side-panel.queue-expanded");
  const expandedTrackListRule = cssRule(nowPlayingCss, ".now-side-panel.queue-expanded .now-panel-tracks");
  const transportRule = cssRuleLast(nowPlayingCss, ".now-transport");
  const transportControlsRule = cssRule(nowPlayingCss, ".now-transport-controls");
  const progressRule = cssRule(nowPlayingCss, ".now-transport .zune-progress");
  const controlsRule = cssRule(playerCss, ".zune-controls button");
  const playRule = cssRule(playerCss, ".zune-controls .zune-play");
  const playerProgressRule = cssRule(playerCss, ".player-primary > .zune-progress");
  const playerRule = cssRule(playerCss, ".player");
  const progressLayoutRule = cssRule(playerCss, ".zune-progress");
  const progressHeadingRule = cssRule(playerCss, ".zune-progress-heading");
  const progressLabelButtonRule = cssRule(playerCss, ".zune-progress-heading > button:first-child");
  const progressInputRule = cssRule(playerCss, ".zune-progress input");
  const glowRule = cssRule(nowPlayingCss, ".audio-glow-canvas");

  assert.ok(px(trackListRule, "max-height") <= 180, "right queue should stay compact by default");
  assert.ok(panelRule.includes("bottom: calc(var(--now-transport-height) + var(--now-panel-gap))"));
  assert.ok(panelRule.includes("background: rgba(0, 0, 0, 0.58)"));
  assert.ok(expandedPanelRule.includes("top: clamp(118px, 25vh, 300px)"));
  assert.ok(expandedTrackListRule.includes("height: 100%"));
  assert.ok(expandedTrackListRule.includes("max-height: none"));
  assert.ok(expandedTrackListRule.includes("overflow-y: auto"));
  assert.ok(px(controlsRule, "width") <= 30, "secondary controls should remain visually light");
  assert.ok(px(playRule, "width") <= 42, "play control should not dominate the bottom bar");
  assert.ok(transportRule.includes("bottom: 0"));
  assert.ok(transportRule.includes("height: var(--now-transport-height)"));
  assert.ok(transportControlsRule.includes("height: var(--now-transport-height)"));
  assert.ok(transportControlsRule.includes("background: transparent"));
  assert.ok(progressRule.includes("bottom: 16px"));
  assert.ok(progressRule.includes("left: 50%"));
  assert.ok(progressRule.includes("width: clamp(310px, 24vw, 520px)"));
  assert.ok(px(glowRule, "max-height") <= 122, "glow should stay below the raised progress area");
  assert.ok(nowPlayingView.includes("<PlaybackProgress"));
  assert.ok(nowPlayingView.includes("<TransportControls"));
  assert.ok(playerBarView.includes("<PlaybackProgress"));
  assert.ok(playerBarView.includes("<TransportControls"));
  assert.ok(playerBarView.includes("className=\"player-cover\""));
  assert.ok(playerBarView.includes("<Cover artPath={track?.cover_path}"));
  assert.ok(playerProgressRule.includes("width: 100%"));
  assert.ok(playerRule.includes("grid-template-columns: minmax(180px, 1fr) auto minmax(180px, 1fr)"));
  assert.ok(progressLayoutRule.includes("grid-template-rows: 18px 10px 13px"));
  assert.ok(progressHeadingRule.includes("grid-column: 1 / -1"));
  assert.ok(progressLabelButtonRule.includes("padding: 0"), "track title should share the progress rail's left edge");
  assert.ok(progressInputRule.includes("grid-column: 1 / -1"));
  assert.ok(playbackProgressView.includes("zune-progress-time-start"));
  assert.ok(playbackProgressView.includes("zune-progress-time-end"));
  assert.ok(nowPlayingView.includes("queueAfterCurrent(queue"), "queue should keep every item around the active track");
  assert.ok(nowPlayingView.includes("useState(true)"), "queue should be expanded on first entry");
  assert.ok(nowPlayingView.includes("orderedQueue.slice(0, COLLAPSED_UPCOMING_COUNT)"));
  assert.ok(nowPlayingView.includes("className=\"queue-disclosure\""));
  assert.ok(nowPlayingView.includes("展开其余 ${hiddenQueueCount} 首"));
  assert.ok(!nowPlayingView.includes("queueExpanded ? 8 : 0"), "collapsed queue must not hide every upcoming track");
});

test("now playing enters in layered Zune order without delaying transport", () => {
  assert.ok(nowPlayingView.includes('isEntering ? "stage-entering"'));
  assert.ok(nowPlayingView.includes('wallRevealStarted ? "wall-reveal-started"'));
  assert.ok(nowPlayingView.includes("onInitialRevealStart={handleInitialWallRevealStart}"));
  assert.ok(animationCss.includes(".stage-entering .now-side-panel"));
  assert.ok(cssRule(animationCss, ".stage-entering .now-track-card").includes("opacity: 0"));
  assert.ok(animationCss.includes(".stage-entering.wall-reveal-started .now-track-card"));
  assert.ok(animationCss.includes(".stage-entering .now-transport"));
  assert.ok(animationCss.includes("animation: now-queue-enter 240ms 55ms"));
  assert.ok(animationCss.includes("animation: now-track-info-enter 320ms 850ms"));
});

test("lyrics word fill follows the media clock at animation-frame cadence", () => {
  assert.ok(lyricsPaintLoopSource.includes("window.requestAnimationFrame(drawFrame)"));
  assert.ok(lyricsPaintLoopSource.includes("playbackClockRef.current()"));
  assert.ok(lyricsPaintLoopSource.includes("element.style.clipPath"));
  assert.ok(!lyricsCss.includes("transition: clip-path"), "frame-driven word fill must not wait on discrete CSS transitions");
});

test("lyrics keeps transliteration and timed background vocals subordinate to the main line", () => {
  assert.ok(lyricsSource.includes("line.transliteration"));
  assert.ok(lyricsSource.includes("backgroundLineRefs"));
  assert.ok(lyricsSource.includes("backgroundWordProgressRefs"));
  assert.ok(lyricsPaintLoopSource.includes("--lyrics-background-presence"));
  assert.ok(lyricsCss.includes(".lyrics-transliteration"));
  assert.ok(lyricsCss.includes(".lyrics-background-line"));
  assert.ok(lyricsCss.includes("opacity: var(--lyrics-background-presence, 0)"));
  assert.ok(lyricsCss.includes("text-align: right"));
});

test("long-note detail is real-timeline driven, restrained, and browsing safe", () => {
  assert.ok(lyricsPaintLoopSource.includes("lyricsLongNoteEnvelope(word, time)"));
  assert.ok(lyricsPaintLoopSource.includes("line.words?.length && lineIndex === nextActiveIndex"));
  assert.ok(lyricsPaintLoopSource.includes("sustain * 0.016"));
  assert.ok(lyricsPaintLoopSource.includes("sustainElement.style.opacity"));
  assert.ok(lyricsCss.includes(".lyrics-stage.is-browsing .lyrics-word-sustain"));
  assert.ok(lyricsCss.includes(".lyrics-line.is-active .lyrics-word.has-long-note"));
  assert.match(motionCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.lyrics-word\.has-long-note\s*\{[\s\S]*?transform: none !important/);
});

test("lyrics calibration uses one reversible clock mapping per track and source", () => {
  assert.ok(lyricsPaintLoopSource.includes("mediaTimeToLyricsTime(playbackClockRef.current(), timingOffsetMs)"));
  assert.ok(lyricsSource.includes("lyricsTimeToMediaTime(line.start, timingOffsetMs, duration)"));
  assert.ok(lyricsHookSource.includes('const LYRICS_TIMING_STORAGE_KEY = "zone-lyrics-timing-v1"'));
  assert.ok(lyricsHookSource.includes("lyricsTimingKey(track.id, state.document.sourceId)"));
  assert.ok(lyricsCss.includes(".lyrics-settings-timing"));
});

test("lyrics provider retry keeps an explicit loading state and hit area", () => {
  assert.ok(lyricsSourceBrowserSource.includes('disabled={onlineSearch.status === "loading"}'));
  assert.ok(lyricsSourceBrowserSource.includes('onlineSearch.status === "loading" ? "正在重试…" : "重新搜索"'));
  assert.ok(lyricsSourceBrowserSource.includes('aria-busy={onlineSearch.status === "loading"}'));
  assert.ok(lyricsSourceBrowserSource.includes("onPointerDown={(event) =>"));
  assert.ok(lyricsSourceBrowserSource.includes("if (event.detail === 0) runSourceAction(onSearchOnline)"));
  assert.match(lyricsCss, /\.lyrics-source-refresh\s*\{[\s\S]*?min-height:\s*36px/);
  assert.match(lyricsCss, /\.lyrics-source-browser\s*\{[\s\S]*?pointer-events:\s*auto/);
});

test("manual lyrics search queries every enabled provider and labels the aggregate", () => {
  assert.ok(lyricsHookSource.includes('searchLyricsProviders(activeQuery, providerConfigs, controller.signal, "all")'));
  assert.ok(lyricsHookSource.includes("selectDiverseLyricsCandidates(result.candidates, MAX_REMOTE_CANDIDATES)"));
  assert.ok(lyricsSourceBrowserSource.includes("来自 ${providerCount} 个来源"));
  assert.ok(lyricsSourceBrowserSource.includes("candidate.providerName"));
  assert.ok(lyricsSourceBrowserSource.includes("lyrics-provider-outcomes"));
  assert.ok(lyricsSourceBrowserSource.includes("providerOutcomeLabel(provider.status)"));
  assert.ok(lyricsCss.includes(".lyrics-provider-outcomes"));
});

test("lyrics search metadata can be corrected without rewriting local tags", () => {
  assert.ok(lyricsSourceBrowserSource.includes("保存并搜索"));
  assert.ok(lyricsSourceBrowserSource.includes("恢复标签"));
  assert.ok(lyricsSourceBrowserSource.includes("onUpdateSearchMetadata(searchMetadataDraft)"));
  assert.ok(lyricsHookSource.includes("queryOverrides"));
  assert.ok(lyricsHookSource.includes("queryRef.current = nextQuery"));
  assert.ok(lyricsHookSource.includes("suppressQueryReloadKeyRef"));
  assert.ok(lyricsCss.includes(".lyrics-search-metadata-form"));
});

test("mosaic canvas animates a multi-color field instead of a brightness sweep", () => {
  assert.ok(!mosaicCanvasSource.includes("energyRef"));
  assert.ok(!mosaicCanvasSource.includes("createEnergyTint"));
  assert.ok(!/globalAlpha\s*=\s*[^;\n]*(energy|beatPulse)/.test(mosaicCanvasSource));
  assert.ok(!/brightness\([^)]*(energy|beatPulse)/.test(mosaicCanvasSource));
  assert.ok(mosaicCanvasSource.includes("createMosaicColorFieldSampler"));
  assert.ok(mosaicCanvasSource.includes('globalCompositeOperation = "color"'));
  assert.ok(!mosaicCanvasSource.includes("createMosaicColorSweep"));
  assert.ok(!mosaicCanvasSource.includes("sepia(0.66)"));
});

test("mosaic waits for decoded covers and reveals without text placeholders", () => {
  assert.ok(mosaicCanvasSource.includes("await preloadWallImages(wallAlbums)"));
  assert.ok(mosaicCanvasSource.includes("image.decode()"));
  assert.ok(mosaicCanvasSource.includes("mosaicTileRevealAmount(tile.seed"));
  assert.ok(mosaicCanvasSource.includes("wallRevealStartedAtRef.current"));
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

test("both pages share Zune's collapsed and hover-expanded volume pattern", () => {
  const volumeRule = cssRule(playerCss, ".zune-volume");
  const inputRule = cssRuleLast(playerCss, ".zune-volume input");

  assert.ok(px(volumeRule, "width") <= 74, "idle volume control should only reserve room for its value");
  assert.ok(inputRule.includes("width: 0"));
  assert.ok(inputRule.includes("opacity: 0"));
  assert.ok(playerCss.includes(".zune-volume:hover .zune-volume-icon"));
  assert.ok(playerCss.includes("width: 96px"));
  assert.ok(nowPlayingView.includes("<VolumeControl"));
  assert.ok(playerBarView.includes("<VolumeControl"));
});

test("responsive rules no longer reference removed visualizer structures", () => {
  assert.ok(motionCss.includes(".now-mosaic-canvas"));
  assert.ok(motionCss.includes(".audio-glow-canvas"));
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
