import assert from "node:assert/strict";
import test from "node:test";
import { parseLrc, parseLyricsSource, parsePlain, parseTtml } from "../.tmp/visualizer-tests/utils/lyrics.js";

test("line LRC becomes a sorted line-synced document", () => {
  const document = parseLrc(
    "track-1",
    "sidecar:test.lrc",
    "[ar:Zone]\n[00:05.50]second line\n[00:01.25]first line",
    12,
  );

  assert.equal(document?.format, "line");
  assert.deepEqual(document?.lines.map((line) => line.text), ["first line", "second line"]);
  assert.equal(document?.lines[0].start, 1.25);
  assert.equal(document?.lines[0].end, 5.5);
  assert.equal(document?.lines[1].end, 12);
});

test("enhanced LRC preserves frame-ready word timing", () => {
  const document = parseLrc(
    "track-2",
    "sidecar:test.lrc",
    "[00:02.00]<00:02.00>夜色<00:03.00>点亮\n[00:05.00]下一句",
    8,
  );

  assert.equal(document?.format, "word");
  assert.deepEqual(document?.lines[0].words, [
    { text: "夜色", start: 2, end: 3 },
    { text: "点亮", start: 3, end: 5 },
  ]);
});

test("duplicate LRC timestamps become translations", () => {
  const document = parseLrc(
    "track-3",
    "embedded:track-3",
    "[00:01.00]Hello\n[00:01.00]你好\n[00:04.00]Next",
  );

  assert.equal(document?.lines[0].text, "Hello");
  assert.equal(document?.lines[0].translation, "你好");
});

test("TTML paragraph and span timing normalize to words", () => {
  const document = parseTtml(
    "track-4",
    "sidecar:test.ttml",
    `<?xml version="1.0"?><tt><body><div>
      <p begin="00:00:01.000" end="00:00:04.000">
        <span begin="1s" end="2.5s">Hello </span><span begin="2.5s">world</span>
      </p>
    </div></body></tt>`,
  );

  assert.equal(document?.format, "word");
  assert.equal(document?.lines[0].text, "Hello world");
  assert.deepEqual(document?.lines[0].words, [
    { text: "Hello ", start: 1, end: 2.5 },
    { text: "world", start: 2.5, end: 4 },
  ]);
});

test("plain lyrics stay explicitly unsynchronized", () => {
  const source = {
    source_id: "manual:test.txt",
    origin: "manual",
    format_hint: "plain",
    label: "test.txt",
    content: "first\n\nsecond",
    is_manual: true,
  };
  const document = parseLyricsSource("track-5", source);

  assert.deepEqual(document, parsePlain("track-5", "manual:test.txt", "first\n\nsecond"));
  assert.equal(document?.format, "plain");
  assert.ok(document?.lines.every((line) => line.start === 0 && line.end === 0));
});
