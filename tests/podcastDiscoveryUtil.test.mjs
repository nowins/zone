import assert from "node:assert/strict";
import test from "node:test";

import {
  addPodcastSearchHistory,
  normalizePodcastSearchHistory,
} from "../.tmp/visualizer-tests/utils/podcastDiscovery.js";

test("podcast search history keeps the newest unique trimmed string terms", () => {
  const input = [
    "  科技  ",
    "BUSINESS",
    "科技",
    42,
    "",
    "business",
    null,
    "人文",
    "英语",
    "通勤",
    "访谈",
    "新闻",
  ];

  assert.deepEqual(normalizePodcastSearchHistory(input), [
    "科技",
    "BUSINESS",
    "人文",
    "英语",
    "通勤",
    "访谈",
  ]);
  assert.deepEqual(input.slice(0, 3), ["  科技  ", "BUSINESS", "科技"]);
});

test("podcast search history rejects invalid containers and supports a bounded custom limit", () => {
  assert.deepEqual(normalizePodcastSearchHistory(null), []);
  assert.deepEqual(normalizePodcastSearchHistory("科技"), []);
  assert.deepEqual(normalizePodcastSearchHistory({ 0: "科技" }), []);
  assert.deepEqual(normalizePodcastSearchHistory(["甲", "乙", "丙"], 2), [
    "甲",
    "乙",
  ]);
  assert.deepEqual(normalizePodcastSearchHistory(["甲"], 0), []);
  assert.deepEqual(normalizePodcastSearchHistory(["甲"], -1), []);
});

test("adding podcast search history moves a term to the front without case variants", () => {
  const history = ["科技", "Business", "人文", "英语", "通勤", "访谈"];

  assert.deepEqual(addPodcastSearchHistory(history, " business "), [
    "business",
    "科技",
    "人文",
    "英语",
    "通勤",
    "访谈",
  ]);
  assert.deepEqual(addPodcastSearchHistory(history, "新闻", 3), [
    "新闻",
    "科技",
    "Business",
  ]);
  assert.deepEqual(addPodcastSearchHistory(history, "   "), history);
  assert.deepEqual(addPodcastSearchHistory("invalid", "科技"), ["科技"]);
  assert.deepEqual(history, [
    "科技",
    "Business",
    "人文",
    "英语",
    "通勤",
    "访谈",
  ]);
});
