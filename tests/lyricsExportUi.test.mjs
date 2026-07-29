import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panelSource = readFileSync("src/components/lyricsStage/LyricsSettingsPanel.tsx", "utf8");
const hookSource = readFileSync("src/hooks/useLyrics.ts", "utf8");
const lyricsCss = readFileSync("src/styles/lyrics.css", "utf8");
const rustSource = readFileSync("src-tauri/src/lyrics.rs", "utf8");
const libSource = readFileSync("src-tauri/src/lib.rs", "utf8");

test("lyrics export presents lossless TTML and explicit LRC tradeoffs", () => {
  assert.ok(panelSource.includes("完整保留逐词、翻译、音译和背景人声"));
  assert.ok(panelSource.includes("不含音译、背景人声"));
  assert.ok(panelSource.includes('exportLyrics("ttml")'));
  assert.ok(panelSource.includes('exportLyrics("lrc")'));
  assert.ok(lyricsCss.includes(".lyrics-settings-export"));
});

test("lyrics export bakes calibration and writes only through a save dialog", () => {
  assert.ok(hookSource.includes("serializeLyricsDocument(state.document, format, timingOffsetMs)"));
  assert.ok(hookSource.includes('invoke<string | null>("export_lyrics_file"'));
  assert.ok(rustSource.includes("fn export_lyrics_file("));
  assert.ok(rustSource.includes("LYRICS_EXPORT_CONTENT_LIMIT"));
  assert.ok(rustSource.includes(".save_file()"));
  assert.ok(libSource.includes("export_lyrics_file,"));
});
