import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCanvasMosaicTiles,
  createMosaicColorSweep,
  createMosaicFlipState,
  createMosaicMotion,
  colorToZuneTint,
  createSlowTint,
  lerpColor,
  mosaicTileRevealAmount,
  relativeLuminance,
  updateMosaicFlipState,
} from "../.tmp/visualizer-tests/utils/nowPlayingCanvas.js";

test("canvas mosaic layout is stable, varied, and square-only", () => {
  const albums = [
    makeAlbum("a", "One", "Artist"),
    makeAlbum("b", "Two", "Artist"),
    makeAlbum("c", "Three", "Elsewhere"),
  ];
  const first = buildCanvasMosaicTiles(1600, 900, albums);
  const second = buildCanvasMosaicTiles(1600, 900, albums);
  const areas = first.map((tile) => tile.width * tile.height);
  const uniqueAreas = new Set(areas);

  assert.deepEqual(first, second);
  assert.ok(first.length > 80, `expected enough tiles to fill the stage, got ${first.length}`);
  assert.ok(uniqueAreas.size >= 3, `expected varied square tile sizes, got ${uniqueAreas.size}`);
  assert.ok(first.every((tile) => tile.width === tile.height), "album wall should not create rectangular tiles");
  assert.ok(first.some((tile) => tile.width >= 150), "layout should include larger Metro-like square tiles");
  assert.ok(first.some((tile) => tile.x < 0 || tile.y < 0), "layout should overflow the viewport for panning");
});

test("canvas mosaic falls back when no albums are available", () => {
  const tiles = buildCanvasMosaicTiles(1280, 720, []);

  assert.ok(tiles.length > 60);
  assert.ok(tiles.every((tile) => tile.albumIndex === 0));
});

test("zune tint stays dark and constrained while allowing slow color movement", () => {
  const source = { r: 248, g: 80, b: 210 };
  const tint = colorToZuneTint(source);
  const later = createSlowTint(tint, 180);
  const calm = createSlowTint(tint, 0);
  const halfway = lerpColor(calm, later, 0.5);

  assert.ok(relativeLuminance(tint) < 0.11, `base tint should stay dark, got ${relativeLuminance(tint)}`);
  assert.ok(relativeLuminance(later) < 0.14, `slow tint should remain restrained, got ${relativeLuminance(later)}`);
  assert.notDeepEqual(calm, later, "time should move the wall color slowly");
  assert.ok(halfway.r >= Math.min(calm.r, later.r) && halfway.r <= Math.max(calm.r, later.r));
});

test("mosaic color light roams the wall and shifts hue as it travels", () => {
  const tint = colorToZuneTint({ r: 40, g: 170, b: 220 });
  const first = createMosaicColorSweep({
    baseTint: tint,
    timeSeconds: 4,
    isPlaying: true,
  });
  const later = createMosaicColorSweep({
    baseTint: tint,
    timeSeconds: 32,
    isPlaying: true,
  });
  const paused = createMosaicColorSweep({
    baseTint: tint,
    timeSeconds: 4,
    isPlaying: false,
  });

  assert.notEqual(first.x, later.x, "the light should travel horizontally");
  assert.notEqual(first.y, later.y, "the light should travel vertically");
  assert.notDeepEqual(first.color, later.color, "light color should drift as it moves");
  assert.equal(first.alpha, paused.alpha, "audio/play state should not change light brightness");
  assert.ok(first.alpha >= 0.13 && first.alpha <= 0.24, `light alpha should be visible but restrained, got ${first.alpha}`);
  assert.ok(first.x > 0 && first.x < 1 && first.y > 0 && first.y < 1, "the light should stay on the wall");
  assert.ok(relativeLuminance(first.color) < 0.16, `light color should stay dark, got ${relativeLuminance(first.color)}`);
});

test("mosaic wall breathes across useful distances without exposing its edges", () => {
  const first = createMosaicMotion(0);
  const later = createMosaicMotion(16);

  assert.notDeepEqual(first, later, "the wall should visibly migrate during ordinary playback");
  for (const motion of [first, later, createMosaicMotion(90)]) {
    assert.ok(Math.abs(motion.driftX) <= 24, `horizontal drift should stay restrained, got ${motion.driftX}`);
    assert.ok(Math.abs(motion.driftY) <= 16, `vertical drift should stay restrained, got ${motion.driftY}`);
    assert.ok(motion.scale >= 1.016 && motion.scale <= 1.034, `breathing scale should stay subtle, got ${motion.scale}`);
  }
});

test("mosaic entry pops tiles in one by one in a brisk non-sequential cascade", () => {
  assert.ok(mosaicTileRevealAmount(0.05, 150) > 0, "an early random tile should already be visible");
  assert.equal(mosaicTileRevealAmount(0.95, 150), 0, "a later random tile should still be hidden");
  assert.equal(mosaicTileRevealAmount(0.95, 900), 1, "the full wall should settle briskly");
  assert.equal(mosaicTileRevealAmount(0.95, 0, false), 1, "reduced motion should reveal the wall immediately");
});

test("mosaic flip scheduler is global, frequent, and commits the live tile back face", () => {
  const albums = [
    makeAlbum("a", "One", "Artist"),
    makeAlbum("b", "Two", "Artist"),
    makeAlbum("c", "Three", "Elsewhere"),
  ];
  const tiles = buildCanvasMosaicTiles(1600, 900, albums);
  const state = createMosaicFlipState();

  updateMosaicFlipState(state, tiles, {
    isPlaying: true,
    beatPulse: 0,
    beatPhase: 0.7,
    beatConfidence: 0,
    albums,
    time: 1_000,
  });

  assert.equal(state.tileIndex, -1);
  assert.ok(state.nextAt >= 2_800 && state.nextAt <= 4_800, `initial flip should be scheduled soon, got ${state.nextAt}`);

  updateMosaicFlipState(state, tiles, {
    isPlaying: true,
    beatPulse: 0,
    beatPhase: 0.7,
    beatConfidence: 0,
    albums,
    time: state.nextAt + 50,
  });

  assert.ok(state.tileIndex >= 0, "low beat confidence should still allow a scheduled flip");
  const flippedTileIndex = state.tileIndex;
  assert.ok(tiles[state.tileIndex].width === tiles[state.tileIndex].height, "flipped tile should be square");
  assert.ok(tiles[state.tileIndex].width >= 104, "scheduler should prefer medium or large tiles");
  assert.ok(state.duration >= 560 && state.duration <= 720, `flip duration should feel like a live tile turn, got ${state.duration}`);
  assert.ok(state.nextAt >= state.startedAt + 5_200 && state.nextAt <= state.startedAt + 10_000, "next flip should arrive within a useful rhythm");
  assert.notEqual(state.fromAlbumIndex, state.toAlbumIndex, "the back face should use a different album");
  assert.notEqual(albums[state.fromAlbumIndex].coverPath, albums[state.toAlbumIndex].coverPath, "the live tile should visibly change artwork");

  const committedAlbumIndex = state.toAlbumIndex;
  updateMosaicFlipState(state, tiles, {
    isPlaying: true,
    beatPulse: 0,
    beatPhase: 0,
    beatConfidence: 0,
    albums,
    time: state.startedAt + state.duration + 1,
  });

  assert.equal(state.tileIndex, -1, "the completed live tile should leave the active animation state");
  assert.equal(tiles[flippedTileIndex].albumIndex, committedAlbumIndex, "the back face must remain as the new front face");
});

test("mosaic flip waits briefly for a confident beat but never disappears", () => {
  const albums = [makeAlbum("a", "One", "Artist"), makeAlbum("b", "Two", "Artist")];
  const tiles = buildCanvasMosaicTiles(1280, 720, albums);
  const state = createMosaicFlipState();
  state.initialized = true;
  state.nextAt = 10_000;

  updateMosaicFlipState(state, tiles, {
    isPlaying: true,
    beatPulse: 0.08,
    beatPhase: 0.55,
    beatConfidence: 0.82,
    albums,
    time: 10_200,
  });
  assert.equal(state.tileIndex, -1, "high-confidence grid should wait briefly for a beat");

  updateMosaicFlipState(state, tiles, {
    isPlaying: true,
    beatPulse: 0.08,
    beatPhase: 0.55,
    beatConfidence: 0.82,
    albums,
    time: 10_660,
  });
  assert.ok(state.tileIndex >= 0, "flip should fire after the beat wait window");
});

test("pausing lets an in-progress live tile finish without snapping back", () => {
  const albums = [makeAlbum("a", "One", "Artist"), makeAlbum("b", "Two", "Artist")];
  const tiles = buildCanvasMosaicTiles(1280, 720, albums);
  const state = createMosaicFlipState();
  state.initialized = true;
  state.nextAt = 1_000;

  updateMosaicFlipState(state, tiles, {
    isPlaying: true,
    beatPulse: 1,
    beatPhase: 0,
    beatConfidence: 1,
    albums,
    time: 1_000,
  });
  const tileIndex = state.tileIndex;
  const target = state.toAlbumIndex;

  updateMosaicFlipState(state, tiles, {
    isPlaying: false,
    beatPulse: 0,
    beatPhase: 0,
    beatConfidence: 0,
    albums,
    time: state.startedAt + state.duration / 2,
  });
  assert.equal(state.tileIndex, tileIndex, "pausing mid-turn should not discard the visible face transition");

  updateMosaicFlipState(state, tiles, {
    isPlaying: false,
    beatPulse: 0,
    beatPhase: 0,
    beatConfidence: 0,
    albums,
    time: state.startedAt + state.duration + 1,
  });
  assert.equal(state.tileIndex, -1);
  assert.equal(tiles[tileIndex].albumIndex, target, "the paused tile should settle on its back face");
});

function makeAlbum(key, album, artist) {
  return {
    key,
    album,
    artist,
    tracks: [],
    coverPath: `${key}.jpg`,
  };
}
