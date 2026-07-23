import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  combineTranslatedLrc,
  normalizeMetadata,
  pickBestLyricsCandidate,
  scoreLyricsCandidate,
  selectDiverseLyricsCandidates,
} from "../.tmp/visualizer-tests/utils/lyricsProviders.js";
import { parseAmllTtmlIndex } from "../.tmp/visualizer-tests/utils/amllTtml.js";

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

test("manual result trimming preserves the best candidate from every provider", () => {
  const candidates = [
    candidate({ id: "lrclib:1" }),
    candidate({ id: "lrclib:2" }),
    candidate({ id: "lrclib:3" }),
    candidate({ id: "qq:1", providerId: "qq", providerName: "QQ 音乐" }),
    candidate({ id: "netease:1", providerId: "netease", providerName: "网易云音乐" }),
  ];
  const selected = selectDiverseLyricsCandidates(candidates, 4);

  assert.equal(selected.length, 4);
  assert.deepEqual(new Set(selected.map((item) => item.providerId)), new Set(["lrclib", "qq", "netease"]));
});

test("translated LRC keeps the original line before its translation", () => {
  assert.equal(
    combineTranslatedLrc(" [00:01.00]Hello ", " [00:01.00]你好 "),
    "[00:01.00]Hello\n[00:01.00]你好",
  );
  assert.equal(combineTranslatedLrc("[00:01.00]Hello", "  "), "[00:01.00]Hello");
  assert.equal(combineTranslatedLrc("", "[00:01.00]你好"), "");
});

test("AMLL JSONL index parsing keeps safe searchable metadata", () => {
  const entries = parseAmllTtmlIndex([
    JSON.stringify({
      metadata: [
        ["album", ["Idol"]],
        ["artists", ["YOASOBI", "Guest"]],
        ["musicName", ["Idol"]],
        ["ncmMusicId", ["2048982668"]],
      ],
      rawLyricFile: "1689089845000-39523898-31c2fa0c.ttml",
    }),
    "not json",
    JSON.stringify({ metadata: [["musicName", ["Unsafe"]]], rawLyricFile: "../unsafe.ttml" }),
  ].join("\n"));

  assert.deepEqual(entries, [{
    rawLyricFile: "1689089845000-39523898-31c2fa0c.ttml",
    title: "Idol",
    artist: "YOASOBI / Guest",
    album: "Idol",
    neteaseId: "2048982668",
  }]);
});

test("QQ provider keeps a legacy search fallback for internal API failures", () => {
  const providersSource = readFileSync("src/lyrics/providers.ts", "utf8");
  assert.ok(providersSource.includes("QQ_LEGACY_SEARCH_URL"));
  assert.ok(providersSource.includes("response.req_1?.code !== 0"));
  assert.ok(providersSource.includes("fallback.data?.song?.list"));
});
