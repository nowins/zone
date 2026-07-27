import assert from "node:assert/strict";
import test from "node:test";

import {
  addPodcastSearchHistory,
  normalizePodcastSearchHistory,
  sortPodcastSearchResults,
  splitPodcastSearchMatch,
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

test("podcast search result relevance sorting preserves API order immutably", () => {
  const results = [
    { id: "a", latestReleaseAt: 20, episodeCount: 2 },
    { id: "b", latestReleaseAt: 30, episodeCount: 3 },
    { id: "c", latestReleaseAt: 10, episodeCount: 1 },
  ];

  const sorted = sortPodcastSearchResults(results, "relevance");

  assert.notEqual(sorted, results);
  assert.deepEqual(sorted.map(({ id }) => id), ["a", "b", "c"]);
  assert.deepEqual(results.map(({ id }) => id), ["a", "b", "c"]);
});

test("podcast search result recent sorting is descending, stable, and missing-last", () => {
  const results = [
    { id: "missing", latestReleaseAt: null },
    { id: "new-a", latestReleaseAt: 30 },
    { id: "invalid", latestReleaseAt: Number.NaN },
    { id: "old", latestReleaseAt: 10 },
    { id: "new-b", latestReleaseAt: 30 },
    { id: "negative", latestReleaseAt: -1 },
    { id: "absent" },
  ];

  assert.deepEqual(
    sortPodcastSearchResults(results, "recent").map(({ id }) => id),
    ["new-a", "new-b", "old", "missing", "invalid", "negative", "absent"],
  );
  assert.deepEqual(results.map(({ id }) => id), [
    "missing",
    "new-a",
    "invalid",
    "old",
    "new-b",
    "negative",
    "absent",
  ]);
});

test("podcast search result episode sorting rejects invalid counts and keeps ties stable", () => {
  const results = [
    { id: "missing", episodeCount: undefined },
    { id: "large-a", episodeCount: 120 },
    { id: "zero", episodeCount: 0 },
    { id: "large-b", episodeCount: 120 },
    { id: "invalid", episodeCount: Number.POSITIVE_INFINITY },
    { id: "negative", episodeCount: -2 },
    { id: "small", episodeCount: 8 },
  ];

  assert.deepEqual(
    sortPodcastSearchResults(results, "episodes").map(({ id }) => id),
    ["large-a", "large-b", "small", "zero", "missing", "invalid", "negative"],
  );
});

test("podcast search matching handles empty queries and no matches without HTML", () => {
  assert.deepEqual(splitPodcastSearchMatch("忽左忽右", "   "), [
    { text: "忽左忽右", matched: false },
  ]);
  assert.deepEqual(splitPodcastSearchMatch("", "忽左"), [
    { text: "", matched: false },
  ]);
  assert.deepEqual(splitPodcastSearchMatch("忽左忽右", "科技"), [
    { text: "忽左忽右", matched: false },
  ]);
});

test("podcast search matching is case-insensitive and highlights every keyword", () => {
  assert.deepEqual(
    splitPodcastSearchMatch("Tech Weekly — weekly BUSINESS", " weekly tech "),
    [
      { text: "Tech", matched: true },
      { text: " ", matched: false },
      { text: "Weekly", matched: true },
      { text: " — ", matched: false },
      { text: "weekly", matched: true },
      { text: " BUSINESS", matched: false },
    ],
  );
});

test("podcast search matching escapes regex syntax and merges adjacent matches", () => {
  assert.deepEqual(
    splitPodcastSearchMatch("C++ (daily). C++daily", "C++ (daily) daily"),
    [
      { text: "C++", matched: true },
      { text: " ", matched: false },
      { text: "(daily)", matched: true },
      { text: ". ", matched: false },
      { text: "C++daily", matched: true },
    ],
  );
});
