import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const css = readFileSync("src/styles/collection-details.css", "utf8");
const source = readFileSync("src/views/ArtistBrowser.tsx", "utf8");
test("artist media index keeps two compact columns without permanent card chrome", () => {
  assert.ok(css.includes("grid-template-columns: repeat(2, minmax(0, 1fr))"));
  assert.ok(css.includes("min-height: 88px"));
  assert.ok(css.includes("width: 72px; height: 72px"));
  assert.ok(css.includes("width: 64px; height: 64px"));
  const entry = css.split(".collection-artist-entry {")[1].split("}")[0];
  assert.ok(!entry.includes("background:") && !entry.includes("border:"));
});
test("artist artwork shares its browse target and identifies a work-cover fallback", () => {
  assert.ok(source.includes("onOpen(artistReference(artist))"));
  assert.ok(source.includes("<Cover artPath={artist.imagePath || cover?.coverPath}"));
  assert.ok(source.includes("!artist.imagePath && cover?.coverPath && <small>作品封面"));
  assert.ok(source.includes("data-collection-focus={`artist-index:"));
});
test("sparse indexes and biography previews retain bounded artwork and text", () => {
  assert.ok(css.includes("minmax(140px, 164px)"));
  assert.ok(css.includes("-webkit-line-clamp: 3"));
  assert.ok(css.includes("font-weight: 300"));
});
