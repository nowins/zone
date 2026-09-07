import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const collectionCss = readFileSync("src/styles/collection.css", "utf8");
const quickplayCss = readFileSync("src/styles/quickplay.css", "utf8");

test("album play actions share a circular Zune treatment", () => {
  const hoverPlay = cssRule(collectionCss, ".album-play");
  const detailPlay = cssRule(collectionCss, ".album-detail-head > button");
  const quickPlay = cssRule(quickplayCss, ".quick-play-cue");

  assert.ok(hoverPlay.includes("border-radius: 50%"));
  assert.ok(detailPlay.includes("border-radius: 50%"));
  assert.ok(quickPlay.includes("border-radius: 50%"));
});

test("circular play actions keep immediate press feedback", () => {
  assert.ok(collectionCss.includes(".collection-album-tile .album-play:active"));
  assert.ok(collectionCss.includes(".album-detail-head > button:active"));
  assert.ok(quickplayCss.includes(".quick-cover-button:active .quick-play-cue"));
});

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[1];
}
