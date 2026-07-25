import assert from "node:assert/strict";
import test from "node:test";

import {
  collectionPlaylistSurfaceCount,
  formatCollectionPlaylistCount,
} from "../.tmp/visualizer-tests/utils/music.js";

test("playlist surface count includes the always-present now-playing row", () => {
  assert.equal(collectionPlaylistSurfaceCount(0), 1);
  assert.equal(collectionPlaylistSurfaceCount(1), 2);
  assert.equal(collectionPlaylistSurfaceCount(3), 4);
  assert.equal(formatCollectionPlaylistCount(3), "4 个列表");
});
