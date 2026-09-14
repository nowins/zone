import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyMetadataOverlays,
  appliedArtistProviderIds,
  artistNeedsAutomaticEnrichment,
  automaticArtistTrackScope,
  metadataTrackInput,
  selectArtistsForAutomaticBackfill,
  selectAutomaticArtistCandidate,
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
    artistImagePath: "D:\\Music\\artist.zone.jpg",
    artistImages: [{
      path: "D:\\Music\\artist.zone.jpg",
      providerId: "local-sidecar",
      providerName: "本地补充文件",
      sourcePath: "D:\\Music\\artist.zone.json",
      confidence: 100,
      updatedAt: 1,
    }, {
      path: "D:\\Music\\artist-portrait.jpg",
      providerId: "netease-music",
      providerName: "网易云音乐",
      sourcePath: "https://music.163.com/artist?id=1",
      confidence: 100,
      updatedAt: 2,
    }],
    artistBiography: "补全歌手简介",
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
  assert.equal(enriched.artist_image_path, "D:\\Music\\artist.zone.jpg");
  assert.deepEqual(
    enriched.artist_images.map((image) => image.path),
    ["D:\\Music\\artist.zone.jpg", "D:\\Music\\artist-portrait.jpg"],
  );
  assert.equal(enriched.artist_biography, "补全歌手简介");
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
    artistImagePath: "D:\\Music\\artist.zone.jpg",
    artistImages: [],
    artistBiography: "补全歌手简介",
    sources: [],
  }]);
  const [restored] = applyMetadataOverlays([enriched], []);

  assert.equal(restored.title, "文件标题");
  assert.equal(restored.year, 2001);
  assert.equal(restored.cover_path, "D:\\Music\\embedded.jpg");
  assert.equal("artist_image_path" in restored, false);
  assert.equal("artist_images" in restored, false);
  assert.equal("artist_biography" in restored, false);
  assert.equal("local_metadata" in restored, false);
  assert.equal("metadata_enrichment" in restored, false);
});

test("automatic artist scope is exact, active-first, bounded, and skips unknown artists", () => {
  const active = track({ id: "active", artist: " 王菲 " });
  const related = track({ id: "related", artist: "王菲" });
  const other = track({ id: "other", artist: "王菲菲" });

  assert.deepEqual(
    automaticArtistTrackScope([related, active, other], active).map((item) => item.id),
    ["active", "related"],
  );
  assert.equal(automaticArtistTrackScope([active, related], active, 1).length, 1);
  assert.deepEqual(
    automaticArtistTrackScope([], track({ artist: "未知艺术家" })),
    [],
  );
});

test("automatic artist selection requires one unambiguous exact artist candidate", () => {
  const candidate = (overrides = {}) => ({
    id: "netease:artist:1",
    kind: "artist",
    providerId: "netease-music",
    providerName: "网易云音乐",
    title: "王菲",
    subtitle: "歌手资料",
    sourcePath: "https://music.163.com/artist?id=1",
    confidence: 100,
    fields: [],
    ...overrides,
  });
  const exact = candidate();

  assert.equal(selectAutomaticArtistCandidate([exact]), exact);
  assert.equal(selectAutomaticArtistCandidate([candidate({ confidence: 99 })]), null);
  assert.equal(selectAutomaticArtistCandidate([
    exact,
    candidate({ id: "netease:artist:2" }),
  ]), null);

  const local = candidate({
    id: "sidecar:artist",
    providerId: "local-sidecar",
    fields: [{ key: "artist_image_path", label: "歌手图片", value: "D:\\artist.jpg" }],
  });
  assert.equal(selectAutomaticArtistCandidate([exact, local]), local);
  assert.equal(
    selectAutomaticArtistCandidate([exact, local], ["local-sidecar"]),
    exact,
  );
  const localBiography = candidate({
    id: "sidecar:biography",
    providerId: "local-sidecar",
    fields: [{ key: "biography", label: "歌手简介", value: "本地简介" }],
  });
  assert.equal(selectAutomaticArtistCandidate([exact, localBiography]), localBiography);
});

test("automatic artist enrichment fills missing fields and secondary images provider by provider", () => {
  const localOnly = track({
    artist_image_path: "D:\\artist.jpg",
    artist_images: [{
      path: "D:\\artist.jpg",
      providerId: "local-sidecar",
      providerName: "本地补充文件",
      sourcePath: "D:\\artist.zone.json",
      confidence: 100,
      updatedAt: 1,
    }],
    artist_biography: "本地简介",
    metadata_enrichment: {
      sources: [{
        field: "artist_image_path",
        providerId: "local-sidecar",
        providerName: "本地补充文件",
        sourcePath: "D:\\artist.zone.json",
        confidence: 100,
        updatedAt: 1,
      }],
    },
  });
  assert.equal(artistNeedsAutomaticEnrichment(localOnly), true);
  assert.deepEqual([...appliedArtistProviderIds(localOnly)], ["local-sidecar"]);
  assert.equal(artistNeedsAutomaticEnrichment(track({
    artist_images: [{ path: "one", providerId: "a" }, { path: "two", providerId: "b" }],
    artist_biography: "已有简介",
  })), false);
});

test("playback enrichment is silent, provider-aware, and excludes podcast playback", () => {
  const hookSource = readFileSync(new URL("../src/hooks/useMetadataEnrichment.ts", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(hookSource, /AUTO_ARTIST_RETRY_MS = 30 \* 60 \* 1_000/);
  assert.match(hookSource, /provider\.id === "local-sidecar"[\s\S]+NETEASE_MUSIC_PROVIDER_ID/);
  assert.match(hookSource, /selectAutomaticArtistCandidate\([\s\S]+await search\(payload\),[\s\S]+appliedProviderIds/);
  assert.match(appSource, /!restored \|\| !isPlaying \|\| activePodcastEpisode \|\| !activeTrack/);
  assert.match(appSource, /metadata\.enrichArtistForPlayback\(activeTrack\)/);
});

test("artist backfill selection groups performers, respects provider state, and stays bounded", () => {
  const first = track({ id: "b", artist: "比莉" });
  const sameArtist = track({ id: "a", artist: " 比莉 " });
  const enriched = track({
    id: "c",
    artist: "蔡琴",
    artist_images: [
      { path: "one", providerId: "netease-music" },
      { path: "two", providerId: "netease-music" },
    ],
    artist_biography: "已有简介",
  });
  const unknown = track({ id: "d", artist: "未知艺术家" });

  const targets = selectArtistsForAutomaticBackfill(
    [first, sameArtist, enriched, unknown],
    ["local-sidecar", "netease-music"],
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "比莉");
  assert.deepEqual(targets[0].tracks.map((item) => item.id), ["a", "b"]);
  assert.equal(targets[0].profile.id, "a");
  assert.equal(
    selectArtistsForAutomaticBackfill([first, sameArtist], ["netease-music"], 1)[0].tracks.length,
    1,
  );
  assert.deepEqual(selectArtistsForAutomaticBackfill([first], []), []);

  const partiallyApplied = track({
    id: "e",
    artist: "陈粒",
    metadata_enrichment: {
      sources: [{
        field: "artist_image_path",
        providerId: "local-sidecar",
        providerName: "本地补充文件",
        sourcePath: "D:\\artist.zone.json",
        confidence: 100,
        updatedAt: 1,
      }],
    },
  });
  assert.deepEqual(selectArtistsForAutomaticBackfill([partiallyApplied], ["local-sidecar"]), []);
  assert.equal(
    selectArtistsForAutomaticBackfill([partiallyApplied], ["local-sidecar", "netease-music"]).length,
    1,
  );
});

test("artist backfill runs silently in the background with throttling and a shared attempt log", () => {
  const hookSource = readFileSync(new URL("../src/hooks/useMetadataEnrichment.ts", import.meta.url), "utf8");

  assert.match(hookSource, /ARTIST_BACKFILL_START_DELAY_MS = 12_000/);
  assert.match(hookSource, /ARTIST_BACKFILL_ARTIST_DELAY_MS = 2_000/);
  assert.match(hookSource, /selectArtistsForAutomaticBackfill\(tracksRef\.current, automaticProviders\)/);
  assert.match(hookSource, /automaticArtistAttemptsRef\.current\.get\(attemptKey\)/);
  assert.match(hookSource, /if \(candidate\) await apply\(payload, candidate\)/);
});

test("metadata enrichment stays behind native commands and an explicit confirmation", () => {
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const hookSource = readFileSync(new URL("../src/hooks/useMetadataEnrichment.ts", import.meta.url), "utf8");
  const infoSource = readFileSync(new URL("../src/components/InfoPanel.tsx", import.meta.url), "utf8");
  const searchSource = readFileSync(new URL("../src/components/MetadataSearchDialog.tsx", import.meta.url), "utf8");
  const editSource = readFileSync(new URL("../src/components/MetadataEditDialog.tsx", import.meta.url), "utf8");
  const rustSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(appSource, /useMetadataEnrichment/);
  assert.match(hookSource, /metadata_get_track_overlays/);
  assert.match(hookSource, /metadata_search_apple_music/);
  assert.match(hookSource, /metadata_apply_apple_music/);
  assert.match(hookSource, /metadata_search_netease_music/);
  assert.match(hookSource, /metadata_apply_netease_music/);
  assert.match(hookSource, /metadata_apply_manual/);
  assert.match(hookSource, /zone-metadata-providers-v1/);
  assert.doesNotMatch(hookSource, /\bfetch\s*\(/);
  assert.match(infoSource, /查找补充信息/);
  assert.match(searchSource, /查找.*信息/);
  assert.match(searchSource, /采用/);
  assert.match(editSource, /编辑.*信息/);
  assert.match(editSource, /不会写入音乐文件/);
  assert.match(infoSource, /恢复本地信息/);
  assert.match(rustSource, /metadata_apply_sidecar/);
  assert.match(rustSource, /metadata_search_apple_music/);
  assert.match(rustSource, /metadata_apply_apple_music/);
  assert.match(rustSource, /metadata_search_netease_music/);
  assert.match(rustSource, /metadata_apply_netease_music/);
  assert.match(rustSource, /metadata_apply_manual/);
  assert.match(rustSource, /metadata_clear_context/);
});
