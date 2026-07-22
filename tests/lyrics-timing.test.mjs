import test from "node:test";
import assert from "node:assert/strict";
import {
  LYRICS_TIMING_LIMIT_MS,
  LYRICS_TIMING_STEP_MS,
  clampLyricsTimingOffset,
  formatLyricsTimingOffset,
  lyricsTimeToMediaTime,
  mediaTimeToLyricsTime,
} from "../.tmp/visualizer-tests/utils/lyricsTiming.js";

test("lyrics timing offset is stepped and bounded", () => {
  assert.equal(LYRICS_TIMING_STEP_MS, 250);
  assert.equal(clampLyricsTimingOffset(374), 250);
  assert.equal(clampLyricsTimingOffset(376), 500);
  assert.equal(clampLyricsTimingOffset(99_000), LYRICS_TIMING_LIMIT_MS);
  assert.equal(clampLyricsTimingOffset(-99_000), -LYRICS_TIMING_LIMIT_MS);
  assert.equal(clampLyricsTimingOffset(Number.NaN), 0);
});

test("positive offsets delay lyrics and round-trip lyric seeks", () => {
  assert.equal(mediaTimeToLyricsTime(12, 500), 11.5);
  assert.equal(mediaTimeToLyricsTime(12, -500), 12.5);
  assert.equal(lyricsTimeToMediaTime(11.5, 500, 30), 12);
  assert.equal(lyricsTimeToMediaTime(29.8, 500, 30), 30);
});

test("lyrics timing offset has concise Chinese labels", () => {
  assert.equal(formatLyricsTimingOffset(0), "同步");
  assert.equal(formatLyricsTimingOffset(250), "延后 0.25 秒");
  assert.equal(formatLyricsTimingOffset(-1_500), "提前 1.5 秒");
});
