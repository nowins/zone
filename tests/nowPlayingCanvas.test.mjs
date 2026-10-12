import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCanvasMosaicTiles,
  advanceMosaicArtwork,
  createMosaicColorFieldMotion,
  createMosaicColorPalette,
  extractMosaicColorPalette,
  createMosaicFlipState,
  createMosaicMotion,
  interpolateMosaicColorPalette,
  mosaicTileRevealAmount,
  mosaicFlipFrame,
  MOSAIC_BLOCK_CELLS,
  relativeLuminance,
  sampleMosaicColorField,
  updateMosaicFlipState,
} from "../.tmp/visualizer-tests/utils/nowPlayingCanvas.js";

test("wall keeps decoded covers through failed loads and rapid retargeting", () => {
  const a = {}, b = {}, c = {};
  const state = { image: null, previous: null, startedAt: 0 };
  advanceMosaicArtwork(state, null, a, 0, 900, 100);
  assert.equal(state.image, a, "a decoded fallback fills an unavailable tile");
  assert.equal(advanceMosaicArtwork(state, b, null, 10, 900, 100), 0);
  assert.equal(state.previous, a);
  const middle = advanceMosaicArtwork(state, c, null, 560, 900, 100);
  assert.ok(middle > 0 && middle < 1);
  assert.equal(state.image, b, "rapid skips finish the visible dissolve before replacing it");
  advanceMosaicArtwork(state, c, null, 1020, 900, 100);
  assert.equal(state.previous, b);
  assert.equal(state.image, c);
  advanceMosaicArtwork(state, null, null, 2200, 900, 100);
  assert.equal(state.image, c, "a failed target never blanks a good tile");
  assert.equal(state.previous, null, "old surfaces are released after a transition");
  assert.equal(advanceMosaicArtwork(state, a, null, 2210, 0, 0), 1);
  assert.equal(state.previous, null, "reduced motion immediately reaches a static cover");
});

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

test("cover sampling produces a restrained multi-color Zune field palette", () => {
  const pixels = makePalettePixels([
    [18, 74, 160],
    [34, 154, 102],
    [184, 52, 42],
    [196, 156, 38],
  ], 32);
  const palette = extractMosaicColorPalette(pixels);
  const uniqueColors = new Set(palette.map((color) => `${Math.round(color.r / 12)}:${Math.round(color.g / 12)}:${Math.round(color.b / 12)}`));

  assert.equal(palette.length, 4);
  assert.ok(uniqueColors.size >= 3, `field needs several distinct colors, got ${JSON.stringify(palette)}`);
  assert.ok(palette.every((color) => relativeLuminance(color) < 0.19), "field colors should stay dark enough for Zune");
});

test("mosaic point lights follow the recovered paths and change local colors over time", () => {
  const palette = createMosaicColorPalette(
    { r: 36, g: 110, b: 188 },
    [{ r: 26, g: 92, b: 188 }, { r: 38, g: 170, b: 102 }],
  );
  const firstMotion = createMosaicColorFieldMotion(0);
  const laterMotion = createMosaicColorFieldMotion(12);
  const positions = [[0.02, 0.02], [0.5, 0.5], [0.02, 0.98]];
  const firstColors = positions.map(([x, y]) => sampleMosaicColorField(palette, 0, x, y));
  const laterColors = positions.map(([x, y]) => sampleMosaicColorField(palette, 12, x, y));

  assert.deepEqual(firstMotion.highlight1, [0.5, 0]);
  assert.deepEqual(firstMotion.highlight2, [0.1, 1]);
  assert.ok(laterMotion.highlight1[0] > firstMotion.highlight1[0], "the upper light moves toward its next stop");
  assert.notDeepEqual(firstColors, laterColors, "the same screen positions should receive different colors over time");
  assert.ok(colorDistance(firstColors[0], firstColors[2]) > 35, "one frame should contain distinct color regions");
});

test("track palette changes interpolate without flashing through unrelated brightness", () => {
  const from = createMosaicColorPalette({ r: 190, g: 52, b: 38 });
  const to = createMosaicColorPalette({ r: 32, g: 112, b: 196 });
  const halfway = interpolateMosaicColorPalette(from, to, 0.5);

  assert.equal(halfway.length, 4);
  assert.ok(halfway.every((color) => relativeLuminance(color) < 0.2));
});

test("color field has no spatial seam during cold entry or cover palette changes", () => {
  const fallback = createMosaicColorPalette({ r: 62, g: 50, b: 44 });
  const targets = [
    // Extracted from the cover which exposed the initialization seam. Its
    // corners straddle the 180-degree route switch at ~30% interpolation.
    [{ r: 26.56, g: 93.29, b: 68.03 }, { r: 26.50, g: 88.25, b: 70.47 },
      { r: 29.04, g: 49.04, b: 93.36 }, { r: 26.03, g: 37.63, b: 91.27 }],
    createMosaicColorPalette({ r: 20, g: 65, b: 190 }),
    createMosaicColorPalette({ r: 195, g: 32, b: 45 }),
    createMosaicColorPalette({ r: 35, g: 150, b: 78 }),
    [{ r: 100, g: 20, b: 20 }, { r: 20, g: 100, b: 20 }, { r: 20, g: 20, b: 100 }, { r: 100, g: 85, b: 20 }],
  ];
  let maximum = 0;
  for (const target of targets) {
    for (const progress of [0, 0.15, 0.3, 0.5, 0.85, 1]) {
      const palette = interpolateMosaicColorPalette(fallback, target, progress);
      for (const time of [0, 1, 12, 50]) {
        for (let row = 0; row < 64; row++) {
          for (let column = 0; column < 64; column++) {
            const x = column / 64, y = row / 64;
            const color = sampleMosaicColorField(palette, time, x, y);
            maximum = Math.max(maximum,
              colorDistance(color, sampleMosaicColorField(palette, time, x + 1 / 64, y)),
              colorDistance(color, sampleMosaicColorField(palette, time, x, y + 1 / 64)));
          }
        }
      }
    }
  }
  assert.ok(maximum < 12, `adjacent field samples must blend across hue wrap; largest jump ${maximum}`);
});

test("neighboring palette transition frames cannot flip the field's hue route", () => {
  const from = createMosaicColorPalette({ r: 62, g: 50, b: 44 });
  const to = createMosaicColorPalette({ r: 25, g: 65, b: 195 });
  for (let step = 1; step <= 120; step++) {
    const previous = interpolateMosaicColorPalette(from, to, (step - 1) / 120);
    const next = interpolateMosaicColorPalette(from, to, step / 120);
    for (const [x, y] of [[0.1, 0.2], [0.4, 0.3], [0.5, 0.5], [0.8, 0.7]]) {
      assert.ok(colorDistance(sampleMosaicColorField(previous, step / 60, x, y),
        sampleMosaicColorField(next, step / 60, x, y)) < 3);
    }
  }
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

test("mosaic entry uses the recovered 200–1300ms random delay and 400ms reveal", () => {
  assert.equal(mosaicTileRevealAmount(0, 200), 0);
  assert.ok(mosaicTileRevealAmount(0.05, 400) > 0, "an early random tile should already be visible");
  assert.equal(mosaicTileRevealAmount(0.95, 400), 0, "a later random tile should still be hidden");
  assert.equal(mosaicTileRevealAmount(1, 1699) < 1, true);
  assert.equal(mosaicTileRevealAmount(1, 1700), 1, "the final delay slice completes after 1700ms");
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
  assert.equal(state.nextAt, 4_700, "entry completes before the first ambient interval");

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
  assert.ok(tiles[state.tileIndex].width >= 70, "all visible square sizes may turn");
  assert.equal(state.duration, 2800, "a turn owns its back-face fade tail");
  assert.equal(state.nextAt, state.startedAt + state.duration + 2000, "turns stay serial with a two-second rest");
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

test("ambient cover turns follow their own clock regardless of a confident beat", () => {
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
  assert.ok(state.tileIndex >= 0, "frequency analysis must not delay ambient artwork");
  const tileIndex = state.tileIndex;

  updateMosaicFlipState(state, tiles, {
    isPlaying: true,
    beatPulse: 0.08,
    beatPhase: 0.55,
    beatConfidence: 0.82,
    albums,
    time: 10_660,
  });
  assert.equal(state.tileIndex, tileIndex, "another beat sample cannot restart the captured turn");
});

test("the repeated 49-square block covers window edges without overlaps and keeps resize identities", () => {
  assert.equal(MOSAIC_BLOCK_CELLS.length, 49);
  assert.equal(MOSAIC_BLOCK_CELLS.filter(([, , size]) => size === 3).length, 7);
  assert.equal(MOSAIC_BLOCK_CELLS.filter(([, , size]) => size === 4).length, 1);
  const small = buildCanvasMosaicTiles(920, 620, []);
  const large = new Map(buildCanvasMosaicTiles(1920, 1080, []).map(tile => [tile.id, tile]));
  for (const tile of small) assert.deepEqual(large.get(tile.id), tile, "existing geometry survives a resize");
  for (const [width, height] of [[920, 620], [1180, 760], [1920, 1080], [3840, 2160], [7680, 4320]]) {
    const tiles = buildCanvasMosaicTiles(width, height, []);
    const sampleStep = width > 3840 ? 70 : 35;
    assert.ok(tiles.length <= 4096, "extreme windows retain a bounded grid");
    for (let y = -24; y <= height + 24; y += sampleStep) {
      for (let x = -24; x <= width + 24; x += sampleStep) {
        const owners = tiles.filter(tile => x >= tile.x && x < tile.x + tile.width && y >= tile.y && y < tile.y + tile.height);
        assert.equal(owners.length, 1, `expected one square at ${width}x${height}: ${x},${y}`);
      }
    }
  }
});

test("a Y-axis turn swaps edge-on and completes rotation before its alpha tail", () => {
  const front = mosaicFlipFrame(350);
  const edge = mosaicFlipFrame(700);
  const back = mosaicFlipFrame(1050);
  const landed = mosaicFlipFrame(1400);
  assert.equal(front.back, false);
  assert.equal(edge.back, true);
  assert.equal(edge.scaleX, 0.02);
  assert.equal(edge.alpha, 0);
  assert.equal(back.back, true);
  assert.ok(back.alpha > edge.alpha && back.alpha < landed.alpha);
  assert.equal(landed.scaleX, 1);
  assert.ok(landed.alpha > 0 && landed.alpha < 1);
  assert.equal(mosaicFlipFrame(2800).alpha, 1);
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

function makePalettePixels(colors, repeats) {
  const values = [];
  for (const color of colors) {
    for (let index = 0; index < repeats; index += 1) values.push(...color, 255);
  }
  return new Uint8ClampedArray(values);
}

function colorDistance(left, right) {
  return Math.hypot(left.r - right.r, left.g - right.g, left.b - right.b);
}
