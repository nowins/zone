import assert from "node:assert/strict";
import test from "node:test";
import {
  combineTranslatedLrc,
  normalizeMetadata,
  pickBestLyricsCandidate,
  scoreLyricsCandidate,
} from "../.tmp/visualizer-tests/utils/lyricsProviders.js";

const query = {
  title: "The Chain",
  artist: "Fleetwood Mac",
  album: "Rumours",
  duration: 270,
};

function candidate(overrides = {}) {
  const base = {
    id: "lrclib:1",
    providerId: "lrclib",
    providerName: "LRCLIB",
    title: "The Chain",
    artist: "Fleetwood Mac",
    album: "Rumours",
    duration: 270.4,
    instrumental: false,
    formatHint: "lrc",
    content: "[00:01.00]Listen to the wind blow",
  };
  const value = { ...base, ...overrides };
  return { ...value, score: scoreLyricsCandidate(query, value) };
}

test("provider metadata normalization ignores common edition suffixes", () => {
  assert.equal(normalizeMetadata("The Chain (2013 Remaster)"), "the chain");
  assert.equal(normalizeMetadata("Song feat. Guest"), "song");
});

test("an exact metadata and duration match receives a near-perfect score", () => {
  const score = scoreLyricsCandidate(query, candidate());
  assert.ok(score.total >= 99);
  assert.equal(score.title, 100);
  assert.equal(score.artist, 100);
});

test("duration contributes an explainable mismatch penalty", () => {
  const close = candidate({ duration: 270.5 });
  const wrongEdition = candidate({ id: "lrclib:2", duration: 313 });
  assert.ok(close.score.duration > wrongEdition.score.duration);
  assert.ok(close.score.total > wrongEdition.score.total);
});

test("automatic selection rejects weak matches below the threshold", () => {
  const weak = candidate({
    title: "Unrelated Song",
    artist: "Different Artist",
    album: "Other Album",
  });
  assert.equal(pickBestLyricsCandidate([weak]), null);
});

test("automatic selection ignores instrumental and empty candidates", () => {
  const valid = candidate();
  const instrumental = candidate({ id: "lrclib:2", instrumental: true });
  const empty = candidate({ id: "lrclib:3", content: "" });
  assert.equal(pickBestLyricsCandidate([instrumental, empty, valid])?.id, valid.id);
});

test("translated LRC keeps the original line before its translation", () => {
  assert.equal(
    combineTranslatedLrc(" [00:01.00]Hello ", " [00:01.00]你好 "),
    "[00:01.00]Hello\n[00:01.00]你好",
  );
  assert.equal(combineTranslatedLrc("[00:01.00]Hello", "  "), "[00:01.00]Hello");
  assert.equal(combineTranslatedLrc("", "[00:01.00]你好"), "");
});
