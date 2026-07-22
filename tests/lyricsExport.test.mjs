import assert from "node:assert/strict";
import test from "node:test";
import { parseLrc, parseTtml } from "../.tmp/visualizer-tests/utils/lyrics.js";
import {
  lyricsExportFileName,
  serializeLyricsDocument,
} from "../.tmp/visualizer-tests/utils/lyricsExport.js";

const document = {
  trackId: "track-export",
  sourceId: "provider:test",
  format: "word",
  lines: [{
    id: "line-1",
    start: 1,
    end: 5,
    text: "Main & voice",
    translation: "主唱",
    transliteration: "mein boisu",
    words: [
      { text: "Main & ", start: 1, end: 3 },
      { text: "voice", start: 3, end: 5 },
    ],
    background: [{
      id: "background-1",
      start: 2,
      end: 4.5,
      text: "back vocal",
      translation: "背景人声",
      transliteration: "bakku bōkaru",
      words: [
        { text: "back ", start: 2, end: 3 },
        { text: "vocal", start: 3, end: 4.5 },
      ],
    }],
  }],
};

test("TTML export round-trips words, auxiliary text, background vocals, and calibration", () => {
  const content = serializeLyricsDocument(document, "ttml", 250);
  const parsed = parseTtml("round-trip", "manual:round-trip", content, 6);

  assert.match(content, /Main &amp; /);
  assert.equal(parsed?.lines[0].text, "Main & voice");
  assert.equal(parsed?.lines[0].start, 1.25);
  assert.equal(parsed?.lines[0].words?.[1].end, 5.25);
  assert.equal(parsed?.lines[0].translation, "主唱");
  assert.equal(parsed?.lines[0].transliteration, "mein boisu");
  assert.equal(parsed?.lines[0].background?.[0].start, 2.25);
  assert.equal(parsed?.lines[0].background?.[0].translation, "背景人声");
  assert.equal(parsed?.lines[0].background?.[0].transliteration, "bakku bōkaru");
});

test("enhanced LRC export keeps word starts and translation without ambiguous auxiliary tracks", () => {
  const content = serializeLyricsDocument(document, "lrc", -250);
  const parsed = parseLrc("round-trip", "manual:round-trip", content, 6);

  assert.match(content, /^\[00:00\.750\]<00:00\.750>Main & <00:02\.750>voice$/m);
  assert.match(content, /^\[00:00\.750\]主唱$/m);
  assert.ok(!content.includes("mein boisu"));
  assert.ok(!content.includes("back vocal"));
  assert.equal(parsed?.lines[0].translation, "主唱");
  assert.deepEqual(parsed?.lines[0].words?.map((word) => word.start), [0.75, 2.75]);
});

test("plain documents export as readable LRC-compatible text", () => {
  const content = serializeLyricsDocument({
    trackId: "plain",
    sourceId: "manual:plain",
    format: "plain",
    lines: [{ id: "plain-1", start: 0, end: 0, text: "first" }, { id: "plain-2", start: 0, end: 0, text: "second" }],
  }, "lrc");
  assert.equal(content, "first\nsecond\n");
});

test("export filenames stay valid on Windows", () => {
  assert.equal(lyricsExportFileName('  21: Guns? / "Live"  ', "ttml"), "21 Guns Live.ttml");
  assert.equal(lyricsExportFileName("...", "lrc"), "歌词.lrc");
});
