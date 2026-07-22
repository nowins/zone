import assert from "node:assert/strict";
import test from "node:test";
import {
  isLyricsLongNote,
  lyricsLongNoteEnvelope,
  LYRICS_LONG_NOTE_MIN_DURATION,
} from "../.tmp/visualizer-tests/utils/lyricsMotion.js";

test("ordinary short words never receive long-note emphasis", () => {
  const word = { text: "word", start: 1, end: 1.6 };
  assert.equal(isLyricsLongNote(word), false);
  assert.equal(lyricsLongNoteEnvelope(word, 1.4), 0);
});

test("a sustained word rises late and releases before its real end", () => {
  const word = { text: "hold", start: 2, end: 4 };
  const early = lyricsLongNoteEnvelope(word, 2.25);
  const sustained = lyricsLongNoteEnvelope(word, 3.5);
  const release = lyricsLongNoteEnvelope(word, 3.94);

  assert.equal(isLyricsLongNote(word), true);
  assert.ok(early < 0.05);
  assert.ok(sustained > 0.9);
  assert.ok(release > 0 && release < sustained);
  assert.equal(lyricsLongNoteEnvelope(word, 4), 0);
});

test("duration weighting prevents threshold-edge words from flashing", () => {
  const thresholdWord = {
    text: "edge",
    start: 0,
    end: LYRICS_LONG_NOTE_MIN_DURATION,
  };
  const strongerWord = { text: "long", start: 0, end: 1.8 };
  assert.equal(lyricsLongNoteEnvelope(thresholdWord, 0.7), 0);
  assert.ok(lyricsLongNoteEnvelope(strongerWord, 1.35) > 0.9);
});
