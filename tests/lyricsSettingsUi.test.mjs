import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stageSource = readFileSync("src/components/LyricsStage.tsx", "utf8");
const displayHookSource = readFileSync("src/hooks/useLyricsDisplaySettings.ts", "utf8");
const lyricsCss = readFileSync("src/styles/lyrics.css", "utf8");
const motionCss = readFileSync("src/styles/motion.css", "utf8");

test("lyrics chrome has one scalable settings entry instead of flat actions", () => {
  assert.ok(stageSource.includes('className={`lyrics-settings-toggle'));
  assert.ok(stageSource.includes('className={`lyrics-settings-panel'));
  assert.ok(stageSource.includes('id="lyrics-display-settings"'));
  assert.ok(stageSource.includes('id="lyrics-sync-settings"'));
  assert.ok(stageSource.includes('id="lyrics-source-settings"'));
  assert.ok(stageSource.includes('id="lyrics-export-settings"'));
  assert.ok(!stageSource.includes("lyrics-timing-popover"));
  assert.ok(!stageSource.includes("lyrics-export-popover"));
});

test("lyrics display preferences are persistent and capability-aware", () => {
  assert.ok(displayHookSource.includes('const LYRICS_DISPLAY_STORAGE_KEY = "zone-lyrics-display-v1"'));
  assert.ok(stageSource.includes('role="switch"'));
  assert.ok(stageSource.includes("showTranslation"));
  assert.ok(stageSource.includes("showTransliteration"));
  assert.ok(stageSource.includes("showBackgroundVocals"));
  assert.ok(stageSource.includes("LYRICS_FONT_SIZE_OPTIONS.map"));
  assert.ok(lyricsCss.includes('[data-lyrics-font-size="small"]'));
  assert.ok(lyricsCss.includes('[data-lyrics-font-size="large"]'));
});

test("lyrics settings and provider search use paired motion lifecycles", () => {
  assert.ok(stageSource.includes("<Presence"));
  assert.ok(stageSource.includes("show={settingsOpen}"));
  assert.ok(stageSource.includes("show={sourceBrowserOpen}"));
  assert.ok(lyricsCss.includes("@starting-style"));
  assert.ok(motionCss.includes(".motion-exit .lyrics-settings-panel"));
  assert.ok(motionCss.includes(".motion-exit .lyrics-source-browser"));
  assert.match(
    motionCss,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.motion-exit \.lyrics-settings-panel,[\s\S]*?motion-exit-reduced/,
  );
});
