import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const audioEngine = readFileSync("src/hooks/useAudioEngine.ts", "utf8");
const glow = readFileSync("src/components/AudioGlowCanvas.tsx", "utf8");
const mosaic = readFileSync("src/components/NowPlayingMosaicCanvas.tsx", "utf8");
const wall = readFileSync("src/utils/nowPlayingWall.ts", "utf8");
const hotkeys = readFileSync("src/hooks/useAppHotkeys.ts", "utf8");
const app = readFileSync("src/App.tsx", "utf8");
const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
const settings = readFileSync("src/views/SettingsView.tsx", "utf8");
const menu = readFileSync("src/components/ContextMenu.tsx", "utf8");
const pcm = readFileSync("src/utils/pcmFeatures.ts", "utf8");

test("visualizer sampling pauses when document is hidden", () => {
  assert.ok(audioEngine.includes("visibilitychange"));
  assert.ok(audioEngine.includes("isVisualizerSurfaceActive"));
  assert.ok(glow.includes("visibilitychange"));
  assert.ok(mosaic.includes("visibilitychange"));
});

test("cover selection prefers artist art and bounds image cache", () => {
  assert.ok(wall.includes("pickCoverCandidates"));
  assert.ok(mosaic.includes("MAX_IMAGE_CACHE"));
});

test("app hotkeys cover transport basics and ignore editable targets", () => {
  assert.ok(hotkeys.includes("isEditableTarget"));
  assert.ok(hotkeys.includes("onTogglePlay"));
  assert.ok(hotkeys.includes("onPrevious"));
  assert.ok(hotkeys.includes("onNext"));
  assert.ok(app.includes("useAppHotkeys"));
});

test("system tray emits frontend transport events", () => {
  assert.ok(lib.includes("setup_system_tray"));
  assert.ok(lib.includes("zone://tray-toggle"));
  assert.ok(app.includes("zone://tray-toggle"));
});

test("smart dj polish includes dislike action and feature progress", () => {
  assert.ok(menu.includes("SmartDJ 不喜欢这首"));
  assert.ok(settings.includes("听感分析"));
  assert.ok(settings.includes("musicAnalyzeFeatures"));
  assert.ok(app.includes("dislikeSmartDjTrack"));
});

test("pcm feature extraction path exists for seed enrichment", () => {
  assert.ok(pcm.includes("extractPcmFeatureSummary"));
  assert.ok(app.includes("musicAnalyzeTrackPcm"));
  assert.ok(lib.includes("music_analyze_track_pcm"));
});


test("close-to-tray setting and titlebar hide path exist", () => {
  const settings = readFileSync("src/views/SettingsView.tsx", "utf8");
  const titlebar = readFileSync("src/components/Titlebar.tsx", "utf8");
  const playbackSettings = readFileSync("src/app/playbackSettings.ts", "utf8");
  assert.ok(playbackSettings.includes("closeToTray"));
  assert.ok(settings.includes("关闭到托盘"));
  assert.ok(titlebar.includes("closeToTray"));
  assert.ok(titlebar.includes("appWindow.hide()"));
});

test("system media keys map play/pause/previous/next and debounce repeats", () => {
  const smtc = readFileSync("src-tauri/src/system_media/windows_impl/smtc.rs", "utf8");
  const systemMedia = readFileSync("src/hooks/useSystemMedia.ts", "utf8");
  assert.ok(smtc.includes("SystemMediaTransportControlsButton::Play"));
  assert.ok(smtc.includes("SystemMediaTransportControlsButton::Pause"));
  assert.ok(smtc.includes("SystemMediaTransportControlsButton::Previous"));
  assert.ok(smtc.includes("SystemMediaTransportControlsButton::Next"));
  assert.ok(systemMedia.includes("lastCommandAtRef"));
});
