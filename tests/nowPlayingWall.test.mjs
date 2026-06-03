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
