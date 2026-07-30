import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyMetadataOverlays,
  metadataTrackInput,
} from "../.tmp/visualizer-tests/utils/metadata.js";

function track(overrides = {}) {
  return {
    id: "track-1",
    path: "D:\\Music\\Artist\\Album\\song.flac",
    file_name: "song.flac",
    title: "文件标题",
    artist: "文件歌手",
    album: "文件专辑",
    album_artist: "文件专辑歌手",
    track_number: 1,
    disc_number: 1,
    year: 2001,
    genres: ["本地流派"],
    duration_seconds: 180,
    extension: "flac",
    cover_path: "D:\\Music\\embedded.jpg",
    ...overrides,
  };
}

test("metadata overlays preserve the original file values", () => {
  const [enriched] = applyMetadataOverlays([track()], [{
    trackId: "track-1",
    title: "补全标题",
    artist: "补全歌手",
    album: "补全专辑",
    albumArtist: "补全专辑歌手",
    year: 2024,
    genres: ["补全流派"],
    coverPath: "D:\\Music\\album.zone.jpg",
    sources: [{
      field: "title",
      providerId: "local-sidecar",
      providerName: "本地补充文件",
      sourcePath: "D:\\Music\\song.zone.json",
      confidence: 100,
      updatedAt: 1,
    }],
  }]);

  assert.equal(enriched.title, "补全标题");
  assert.equal(enriched.cover_path, "D:\\Music\\album.zone.jpg");
  assert.equal(enriched.local_metadata.title, "文件标题");
  assert.equal(enriched.local_metadata.cover_path, "D:\\Music\\embedded.jpg");
  assert.equal(enriched.metadata_enrichment.sources[0].providerId, "local-sidecar");
});

test("metadata requests always use file values instead of an applied overlay", () => {
  const [enriched] = applyMetadataOverlays([track()], [{
    trackId: "track-1",
    title: "补全标题",
    artist: "补全歌手",
    sources: [],
  }]);

  assert.deepEqual(metadataTrackInput(enriched), {
    id: "track-1",
    path: "D:\\Music\\Artist\\Album\\song.flac",
    title: "文件标题",
    artist: "文件歌手",
    album: "文件专辑",
    albumArtist: "文件专辑歌手",
    trackNumber: 1,
    discNumber: 1,
    year: 2001,
    genres: ["本地流派"],
    durationSeconds: 180,
  });
});

test("clearing metadata restores the original file values", () => {
  const [enriched] = applyMetadataOverlays([track()], [{
    trackId: "track-1",
    title: "补全标题",
    year: 2024,
    sources: [],
  }]);
  const [restored] = applyMetadataOverlays([enriched], []);

  assert.equal(restored.title, "文件标题");
  assert.equal(restored.year, 2001);
  assert.equal(restored.cover_path, "D:\\Music\\embedded.jpg");
  assert.equal("local_metadata" in restored, false);
  assert.equal("metadata_enrichment" in restored, false);
});

test("metadata enrichment stays behind native commands and an explicit confirmation", () => {
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const hookSource = readFileSync(new URL("../src/hooks/useMetadataEnrichment.ts", import.meta.url), "utf8");
  const infoSource = readFileSync(new URL("../src/components/InfoPanel.tsx", import.meta.url), "utf8");
  const rustSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(appSource, /useMetadataEnrichment/);
  assert.match(hookSource, /metadata_get_track_overlays/);
  assert.doesNotMatch(hookSource, /\bfetch\s*\(/);
  assert.match(infoSource, /查找本地补充信息/);
  assert.match(infoSource, /采用/);
  assert.match(infoSource, /恢复本地信息/);
  assert.match(rustSource, /metadata_apply_sidecar/);
  assert.match(rustSource, /metadata_clear_context/);
});
