import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LYRICS_DISPLAY_SETTINGS,
  normalizeLyricsDisplaySettings,
} from "../.tmp/visualizer-tests/utils/lyricsDisplay.js";

test("lyrics display settings keep existing presentation defaults", () => {
  assert.deepEqual(normalizeLyricsDisplaySettings(null), DEFAULT_LYRICS_DISPLAY_SETTINGS);
  assert.deepEqual(normalizeLyricsDisplaySettings({}), DEFAULT_LYRICS_DISPLAY_SETTINGS);
});

test("lyrics display settings preserve valid preferences and repair stale values", () => {
  assert.deepEqual(normalizeLyricsDisplaySettings({
    fontSize: "large",
    showTranslation: false,
    showTransliteration: false,
    showBackgroundVocals: true,
  }), {
    fontSize: "large",
    showTranslation: false,
    showTransliteration: false,
    showBackgroundVocals: true,
  });

  assert.deepEqual(normalizeLyricsDisplaySettings({
    fontSize: "oversized",
    showTranslation: "yes",
    showTransliteration: true,
  }), {
    ...DEFAULT_LYRICS_DISPLAY_SETTINGS,
    showTransliteration: true,
  });
});
