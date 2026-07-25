import assert from "node:assert/strict";
import test from "node:test";

import { resolveSearchSurface } from "../.tmp/visualizer-tests/utils/collectionSearch.js";

test("resolveSearchSurface: empty query always shows the library", () => {
  assert.equal(resolveSearchSurface("", "results"), "library");
  assert.equal(resolveSearchSurface("   ", "results"), "library");
  assert.equal(resolveSearchSurface("", "browse"), "library");
});

test("resolveSearchSurface: non-empty query in results mode shows results", () => {
  assert.equal(resolveSearchSurface("周杰伦", "results"), "results");
  assert.equal(resolveSearchSurface(" a ", "results"), "results");
});

test("resolveSearchSurface: non-empty query in browse mode shows the library", () => {
  assert.equal(resolveSearchSurface("周杰伦", "browse"), "library");
});
