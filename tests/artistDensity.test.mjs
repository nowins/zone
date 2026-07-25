import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const artistSource = readFileSync("src/views/ArtistBrowser.tsx", "utf8");
const collectionCss = readFileSync("src/styles/collection.css", "utf8");

test("artist browser keeps useful density at the default window size", () => {
  const browserRule = cssRule(collectionCss, ".artist-browser");
  const pickerRule = cssRule(collectionCss, ".artist-picker button");
  const albumGridRule = cssRule(collectionCss, ".artist-album-grid");
  const songRule = cssRule(collectionCss, ".artist-song-list button");

  assert.ok(browserRule.includes("clamp(220px, 20vw, 300px)"));
  assert.ok(browserRule.includes("gap: 24px"));
  assert.ok(pickerRule.includes("min-height: 32px"));
  assert.ok(pickerRule.includes("padding: 0"));
  assert.ok(albumGridRule.includes("minmax(112px, 1fr)"));
  assert.ok(songRule.includes("min-height: 36px"));
});

test("artist album grid scales cover density by album count", () => {
  assert.ok(artistSource.includes("data-count={artistAlbums.length}"));
  const singleRule = cssRule(collectionCss, '.artist-album-grid[data-count="1"]');
  const pairRule = cssRule(collectionCss, '.artist-album-grid[data-count="2"]');
  assert.ok(singleRule.includes("minmax(0, 168px)"));
  assert.ok(pairRule.includes("repeat(2, minmax(0, 140px))"));
});

test("artist rows stay quiet and align with the collection total", () => {
  assert.ok(!artistSource.includes("artistSummaries"));
  assert.ok(!artistSource.includes("albumCount"));
  assert.ok(!artistSource.includes("张 ·"));
  assert.ok(!collectionCss.includes(".artist-picker button > small"));
});

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[1];
}
