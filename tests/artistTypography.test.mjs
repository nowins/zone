import assert from "node:assert/strict";
import test from "node:test";
import { artistTypographyModel, artistTextGraphemes, createArtistTypographyClock, advanceArtistTypography,
  artistTypographyLayers, artistTypographyLines, artistTypographyFrame } from "../.tmp/visualizer-tests/utils/artistTypography.js";
import { createArtistTypographyAtlas, artistTypographyQuads } from "../.tmp/visualizer-tests/utils/artistTypographyAtlas.js";

const model = artistTypographyModel({ artist: "Coldplay", title: "Viva La Vida", album: "Viva La Vida" });
test("decorative text uses unique local titles, normalized Unicode and bounded graphemes", () => {
  assert.deepEqual(model.text, ["VIVA LA VIDA", "COLDPLAY"]);
  assert.equal(artistTypographyModel({ artist: "a", album_artist: "b" }).artist, "B");
  const family = "👨‍👩‍👧‍👦", long = artistTypographyModel({ artist: family.repeat(70), album: "e\u0301\n\t music" });
  assert.equal(artistTextGraphemes(long.artist).length, 48);
  assert.ok(long.artist.endsWith("…"));
  assert.equal(long.album, "É MUSIC");
  assert.deepEqual(artistTypographyModel(null).text, []);
  assert.equal(artistTypographyModel({ ...model, play_count: 999, artist_bio: "Network biography" }).key,
    artistTypographyModel(model).key, "service fields cannot enter typography");
});
test("clip choice spans four types and excludes the preceding type", () => {
  assert.deepEqual([0, .25, .5, .99].map(random => createArtistTypographyClock(model, 0, undefined, () => random).current.kind),
    ["letters", "lines", "cluster", "angled"]);
  for (const previous of ["letters", "lines", "cluster", "angled"])
    for (const random of [0, .4, .999]) assert.notEqual(createArtistTypographyClock(model, 0, previous, () => random).current.kind, previous);
});
test("metadata handoffs retain their outgoing model and converge to the latest rapid skip", () => {
  const clock = createArtistTypographyClock(model, 0, undefined, () => .6);
  const next = artistTypographyModel({ artist: "Coldplay", title: "Violet Hill" });
  const last = artistTypographyModel({ artist: "Coldplay", title: "Yellow" });
  advanceArtistTypography(clock, next, 7000, 0, false);
  assert.equal(clock.previous.model.key, model.key);
  assert.equal(clock.current.originMs, 7000);
  advanceArtistTypography(clock, last, 7000, 200, false);
  assert.deepEqual(artistTypographyLayers(clock).map(layer => layer.opacity), [.5, .5]);
  assert.equal(clock.current.model.key, next.key);
  advanceArtistTypography(clock, last, 7000, 200, false);
  advanceArtistTypography(clock, last, 7000, 0, false, false);
  assert.equal(clock.current.model.key, last.key);
  assert.equal(clock.current.originMs, 7000 - 12800, "paused local metadata gets a visible static phase");
  advanceArtistTypography(clock, last, 7000, 400, false, false);
  assert.equal(clock.previous, null);
  advanceArtistTypography(clock, model, 7000, 0, true);
  assert.equal(clock.previous, null);
  assert.equal(clock.current.model.key, model.key);
});
test("native reference sizes, stagger and two 16-second phases remain distinct", () => {
  const full = artistTypographyModel({ artist: "Coldplay", album: "Parachutes", title: "Yellow" });
  assert.deepEqual(artistTypographyLines("letters", full).map(line => line.size), [42, 140, 42]);
  const letters = artistTypographyLines("letters", full)[0];
  assert.equal(artistTypographyFrame("letters", letters, 0, 6, 0, false).opacity, 0);
  assert.ok(artistTypographyFrame("letters", letters, 0, 6, 2000, false).opacity >
    artistTypographyFrame("letters", letters, 1, 6, 2000, false).opacity);
  for (const kind of ["cluster", "angled"]) {
    const lines = artistTypographyLines(kind, full), first = lines[0], second = lines[3];
    assert.equal(artistTypographyFrame(kind, second, 0, 5, 15999, false).opacity, 0);
    assert.equal(artistTypographyFrame(kind, first, 0, 5, 16000, false).opacity, 0);
    assert.equal(artistTypographyFrame(kind, second, 0, 5, 20000, false).opacity, 1);
    assert.equal(artistTypographyFrame(kind, first, 0, 5, 50000, true).opacity, 1);
    assert.equal(artistTypographyFrame(kind, second, 0, 5, 50000, true).opacity, 0);
  }
});
function atlasDocument() {
  let measures = 0, fills = 0;
  const context = { font: "", measureText(text) { measures++; const size = Number(this.font.match(/(\d+)px/)[1]);
    return { width: artistTextGraphemes(text).length * size * (/\p{Script=Han}/u.test(text) ? 1 : .6), actualBoundingBoxAscent: size * .8 }; }, fillText() { fills++; } };
  return { document: { createElement() { return { width: 0, height: 0, getContext: () => context }; } }, counts: () => ({ measures, fills }) };
}
test("Chinese and emoji atlases remain bounded, reuse rasterized glyphs and project both viewport sizes", () => {
  const local = artistTypographyModel({ artist: "周末班车👨‍👩‍👧‍👦", album: "专辑".repeat(35), title: "你没问过我为什么变了".repeat(8) });
  for (const kind of ["letters", "lines", "cluster", "angled"]) {
    const env = atlasDocument(), atlas = createArtistTypographyAtlas(env.document, kind, local);
    assert.ok(atlas.canvas.width <= 1024 && atlas.canvas.height <= 1024);
    const counts = env.counts();
    const clip = { kind, model: local, originMs: 0 };
    for (const [width, height] of [[1180, 760], [920, 620]]) {
      const text = artistTypographyQuads(atlas, clip, 10000, width, height, false);
      assert.ok(text.glyphs.length > 0);
      for (const glyph of text.glyphs) {
        assert.ok(glyph.vertices.every(point => [point.x, point.y, point.w].every(Number.isFinite)));
        assert.ok(glyph.uv.every(point => point.u >= 0 && point.u <= 1 && point.v >= 0 && point.v <= 1));
      }
    }
    assert.deepEqual(env.counts(), counts, "frames do not remeasure or rasterize text");
  }
});
test("wrapped Chinese titles leave room above the glyphs and balance their two rows", () => {
  const local = artistTypographyModel({ artist: "周末班车", title: "你没问过我为什么变了" });
  const env = atlasDocument(), atlas = createArtistTypographyAtlas(env.document, "lines", local);
  const title = atlas.placed.filter(item => item.line.index === 0);
  const rows = [...new Set(title.map(item => item.y))];
  assert.equal(rows.length, 2);
  const counts = rows.map(y => title.filter(item => item.y === y).length);
  assert.ok(Math.abs(counts[0] - counts[1]) <= 1);
  assert.ok(title.every(item => item.y - item.glyph.ascent >= 0));
});
