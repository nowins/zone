import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultLyricsSearchMetadata,
  isDefaultLyricsSearchMetadata,
  lyricsQueryForTrack,
  lyricsQueryKey,
  normalizeLyricsSearchMetadata,
} from "../.tmp/visualizer-tests/utils/lyricsSearch.js";

const track = {
  id: "track-1",
  path: "D:/Music/21 Guns.mp3",
  title: "21 Guns",
  artist: "Green Day",
  album: "21st Century Breakdown",
  duration_seconds: 321,
};

test("lyrics search metadata starts from local tags", () => {
  assert.deepEqual(defaultLyricsSearchMetadata(track), {
    title: "21 Guns",
    artist: "Green Day",
    album: "21st Century Breakdown",
  });
  assert.deepEqual(lyricsQueryForTrack(track, 322), {
    title: "21 Guns",
    artist: "Green Day",
    album: "21st Century Breakdown",
    duration: 322,
  });
});

test("lyrics search override trims fields and can intentionally omit artist and album", () => {
  const metadata = normalizeLyricsSearchMetadata({
    title: "  Twenty One Guns  ",
    artist: "   ",
    album: "  ",
  });
  assert.deepEqual(metadata, { title: "Twenty One Guns", artist: "", album: "" });
  assert.deepEqual(lyricsQueryForTrack(track, 0, metadata), {
    title: "Twenty One Guns",
    artist: "",
    album: undefined,
    duration: undefined,
  });
});

test("empty override titles are rejected and exact local tags need no persisted mapping", () => {
  assert.equal(normalizeLyricsSearchMetadata({ title: " ", artist: "Green Day", album: "" }), null);
  assert.equal(isDefaultLyricsSearchMetadata(track, {
    title: " 21 Guns ",
    artist: "Green Day",
    album: "21st Century Breakdown",
  }), true);
});

test("lyrics query cache keys follow corrected metadata", () => {
  const original = lyricsQueryForTrack(track, 321);
  const corrected = lyricsQueryForTrack(track, 321, {
    title: "Twenty One Guns",
    artist: "Green Day",
    album: "21st Century Breakdown",
  });
  assert.notEqual(lyricsQueryKey(original), lyricsQueryKey(corrected));
});
