import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNowPlayingWall,
  NOW_PLAYING_WALL_TILE_COUNT,
  WALL_TILE_PATTERN,
  wallTilePatternForIndex,
} from "../.tmp/visualizer-tests/utils/nowPlayingWall.js";

test("wall tile pattern stays bounded and repeatable", () => {
  assert.equal(WALL_TILE_PATTERN.length, 18);
  assert.deepEqual(wallTilePatternForIndex(WALL_TILE_PATTERN.length), WALL_TILE_PATTERN[0]);

  for (const pattern of WALL_TILE_PATTERN) {
    assert.ok(pattern.columns >= 1 && pattern.columns <= 5, `unexpected column span ${pattern.columns}`);
    assert.ok(pattern.rows >= 1 && pattern.rows <= 4, `unexpected row span ${pattern.rows}`);
  }

  const areas = WALL_TILE_PATTERN.map((pattern) => pattern.columns * pattern.rows);
  const largeTiles = areas.filter((area) => area >= 9);
  assert.ok(Math.max(...areas) <= 12, `wall tiles should not dominate the center, got max area ${Math.max(...areas)}`);
  assert.ok(largeTiles.length <= 1, `only one large tile should appear per pattern cycle, got ${largeTiles.length}`);

  for (let index = 1; index < areas.length; index += 1) {
    assert.ok(
      !(areas[index] >= 8 && areas[index - 1] >= 8),
      `large tiles should not be adjacent at ${index - 1}/${index}`,
    );
  }
});

test("now playing wall keeps active artist and album weighted", () => {
  const active = makeTrack("1", "Aerial", "Red Room", "red.jpg");
  const tracks = [
    active,
    makeTrack("2", "Aerial", "Blue Room", "blue.jpg"),
    makeTrack("3", "Elsewhere", "Side Room", "side.jpg"),
  ];

  const wall = buildNowPlayingWall(tracks, active);
  const activeAlbumCount = wall.filter((album) => album.album === active.album).length;
  const activeArtistCount = wall.filter((album) => album.artist === active.artist).length;
  const otherArtistCount = wall.filter((album) => album.artist !== active.artist).length;

  assert.equal(wall.length, NOW_PLAYING_WALL_TILE_COUNT);
  assert.ok(activeAlbumCount > 0, "active album should be present in the wall");
  assert.ok(activeArtistCount > otherArtistCount, "active artist albums should be weighted over other artists");
});

test("now playing wall falls back when no covers are available", () => {
  const wall = buildNowPlayingWall([makeTrack("1", "No Art", "Missing", null)], null);

  assert.equal(wall.length, NOW_PLAYING_WALL_TILE_COUNT);
  assert.ok(wall.every((album) => album.album === "Zone"));
});

function makeTrack(id, artist, album, coverPath) {
  return {
    id,
    path: `${id}.mp3`,
    file_name: `${id}.mp3`,
    title: `Track ${id}`,
    artist,
    album,
    extension: "mp3",
    cover_path: coverPath,
  };
}

test("an active song without cover art never inserts blank albums into a covered wall", () => {
  const missing = makeTrack("missing", "Artist", "No cover", null);
  const covered = makeTrack("covered", "Other", "Cover", "cover.jpg");
  const wall = buildNowPlayingWall([missing, covered], missing);
  assert.ok(wall.every(album => album.coverPath === "cover.jpg"));
});

test("now playing wall mixes in enriched artist photos for the active artist only", () => {
  const active = makeTrack("1", "蔡琴", "不悔", "buhui.jpg");
  active.artist_image_path = "D:\\art\\tsai.zone.jpg";
  active.artist_images = [
    { path: "D:\\art\\tsai.zone.jpg", providerId: "netease-music" },
    { path: "D:\\art\\tsai-2.zone.jpg", providerId: "netease-music" },
  ];
  const sameArtist = makeTrack("2", "蔡琴", "机遇", null);
  sameArtist.artist_image_path = "D:\\art\\tsai-3.zone.jpg";
  const other = makeTrack("3", "方大同", "橙月", "orange.jpg");
  other.artist_image_path = "D:\\art\\khalil.zone.jpg";

  const wall = buildNowPlayingWall([active, sameArtist, other], active);
  const paths = new Set(wall.map((album) => album.coverPath));
  assert.ok(paths.has("D:\\art\\tsai.zone.jpg"), "active track artist image should appear");
  assert.ok(paths.has("D:\\art\\tsai-2.zone.jpg"), "secondary artist image should appear");
  assert.ok(paths.has("D:\\art\\tsai-3.zone.jpg"), "same-artist track image should appear");
  assert.ok(!paths.has("D:\\art\\khalil.zone.jpg"), "other artists' photos stay out");

  const artistKeys = new Set(
    wall.filter((album) => album.key.startsWith("artist-image:")).map((album) => album.key),
  );
  assert.equal(artistKeys.size, 3, "duplicated artist image paths collapse into one entry");
});

test("artist photos are capped and keep the wall alive without any covers", () => {
  const active = makeTrack("1", "蔡琴", "不悔", null);
  active.artist_image_path = "D:\\art\\tsai-0.zone.jpg";
  active.artist_images = [1, 2, 3, 4, 5].map((n) => ({
    path: `D:\\art\\tsai-${n}.zone.jpg`,
    providerId: "netease-music",
  }));

  const wall = buildNowPlayingWall([active], active);
  assert.ok(wall.some((album) => album.coverPath === "D:\\art\\tsai-0.zone.jpg"));
  assert.ok(wall.every((album) => album.album !== "Zone"), "artist photos prevent the Zone fallback");
  const artistKeys = new Set(
    wall.filter((album) => album.key.startsWith("artist-image:")).map((album) => album.key),
  );
  assert.ok(artistKeys.size <= 4, `artist photos should be capped, got ${artistKeys.size}`);
});
