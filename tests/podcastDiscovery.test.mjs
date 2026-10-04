import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isPodcastDiscoveryFresh, podcastDiscoverySourceLabel } from "../.tmp/visualizer-tests/utils/podcastDiscovery.js";

test("discovery reports the actual provider and marks cached fallback", () => {
  assert.equal(podcastDiscoverySourceLabel({ source: "xyzrank", stale: false }), "XYZRank 中文榜");
  assert.equal(podcastDiscoverySourceLabel({ source: "apple", stale: false }), "Apple 中国区 · 备用来源");
  assert.equal(podcastDiscoverySourceLabel({ source: "xyzrank", stale: true }), "XYZRank 中文榜 · 缓存");
  assert.equal(podcastDiscoverySourceLabel({ source: "apple", stale: true }), "Apple 中国区 · 备用来源 · 缓存");
});

test("fresh discovery cache suppresses requests but stale and invalid timestamps cannot", () => {
  const now = 1_000_000, ttl = 900_000;
  assert.equal(isPodcastDiscoveryFresh({ fetchedAt: now - ttl + 1, stale: false }, now, ttl), true);
  for (const fetchedAt of [now - ttl, 0, now + 1, NaN, Infinity]) {
    assert.equal(isPodcastDiscoveryFresh({ fetchedAt, stale: false }, now, ttl), false);
  }
  assert.equal(isPodcastDiscoveryFresh({ fetchedAt: now, stale: true }, now, ttl), false);
});

const viewSource = [
  "src/views/PodcastView.tsx",
  "src/views/podcast/usePodcastViewModel.ts",
  "src/views/podcast/api.ts",
  "src/views/podcast/screens/ListenScreen.tsx",
  "src/views/podcast/screens/DiscoverScreen.tsx",
  "src/views/podcast/components/DiscoverSearch.tsx",
  "src/views/podcast/screens/LibraryScreen.tsx",
  "src/views/podcast/screens/PlaylistScreen.tsx",
  "src/views/podcast/screens/ShowScreen.tsx",
  "src/views/podcast/screens/EpisodeScreen.tsx",
  "src/views/podcast/constants.ts",
  "src/views/podcast/preferences.ts",
  "src/views/podcast/components/ShowCards.tsx",
].map((path) => readFileSync(path, "utf8")).join("\n");
const stylesSource = readFileSync("src/styles/podcasts.css", "utf8");
const typesSource = readFileSync("src/types.ts", "utf8");
const rustSource = readFileSync("src-tauri/src/podcast/apple.rs", "utf8");

test("podcast discovery offers visible categories without duplicate topic navigation and keeps focus-scoped recent searches", () => {
  assert.match(viewSource, /PODCAST_DISCOVERY_STORAGE_KEY = "zone-podcast-discovery-v1"/);
  assert.match(viewSource, /label: "热门"/);
  assert.match(viewSource, /label: "商业", query: "商业"/);
  assert.match(viewSource, /label: "科技", query: "科技"/);
  assert.match(viewSource, /label: "人文", query: "人文"/);
  assert.match(viewSource, /label: "英语", query: "英语"/);
  assert.match(viewSource, /aria-label="发现节目分类"/);
  assert.match(viewSource, /aria-pressed=\{genre === value\}/);
  assert.doesNotMatch(viewSource, /aria-label="按主题浏览"/);
  assert.doesNotMatch(viewSource, /<select aria-label="发现节目分类"/);
  assert.match(viewSource, /addPodcastSearchHistory\(current, cleanQuery\)/);
  assert.match(viewSource, /searchHistory: normalizePodcastSearchHistory\(searchHistory\)/);
  assert.match(
    viewSource,
    /function writePodcastSearchHistory\([\s\S]*?if \(raw\) \{[\s\S]*?try \{[\s\S]*?JSON\.parse\(raw\)[\s\S]*?catch \{[\s\S]*?current = \{\};[\s\S]*?localStorage\.setItem/,
  );
  assert.match(viewSource, /aria-label="最近搜索"/);
  assert.match(viewSource, />\s*清空\s*</);
  assert.match(
    viewSource,
    /setPodcastSessionSnapshot\(\{[\s\S]*?discoveryTopic,[\s\S]*?searchHeading,[\s\S]*?searchState,[\s\S]*?searchResults,/,
  );
  assert.match(
    viewSource,
    /restoredSession\?\.searchState === "loading"[\s\S]*?\? "popular"[\s\S]*?: restoredSession[\s\S]*?\? restoredSession\.discoveryTopic/,
  );
});

test("topic and manual searches share one race-safe Apple search path", () => {
  const searchStart = viewSource.indexOf("async function runAppleSearch(");
  const searchEnd = viewSource.indexOf("\n  async function openStoredFeed(", searchStart);
  const searchSource = viewSource.slice(searchStart, searchEnd);

  assert.match(searchSource, /appleSearchRequestRef\.current = requestId/);
  assert.match(searchSource, /podcastApi\.searchApplePodcasts\(cleanQuery, 18\)/);
  assert.match(viewSource, /"podcast_search_apple"/);
  assert.match(
    searchSource,
    /if \(appleSearchRequestRef\.current !== requestId\) return;[\s\S]*?setSearchResults\(results\)/,
  );
  assert.match(searchSource, /void runAppleSearch\(query, \{ remember: true \}\)/);
  assert.match(searchSource, /void runAppleSearch\(topicOption\.query,/);
  assert.match(searchSource, /void runAppleSearch\(historyQuery, \{ remember: true \}\)/);
  assert.match(
    searchSource,
    /function showPopularDiscovery\(\)[\s\S]*?appleSearchRequestRef\.current \+= 1[\s\S]*?setSearchState\("idle"\)[\s\S]*?loadDiscovery\(\)/,
  );
});

test("RSS subscription is prominent, accessible, and keeps the native command boundary", () => {
  assert.match(viewSource, /className="podcast-rss-toggle"/);
  assert.match(viewSource, /aria-expanded=\{rssExpanded\}/);
  assert.match(viewSource, /aria-controls="podcast-rss-subscribe"/);
  assert.match(viewSource, /id="podcast-rss-subscribe"/);
  assert.match(viewSource, /"podcast_subscribe"/);
  assert.doesNotMatch(viewSource, /fetch\(/);
  assert.match(
    stylesSource,
    /\.podcast-rss-toggle\s*\{[\s\S]*?min-height:\s*44px/,
  );
  assert.match(
    stylesSource,
    /\.podcast-discovery-topics button\s*\{[\s\S]*?min-height:\s*40px/,
  );
  assert.match(
    stylesSource,
    /\.podcast-search-history-clear\s*\{[\s\S]*?min-height:\s*40px/,
  );
  assert.match(viewSource, /actionLabel="返回热门"/);
});

test("search results expose only real Apple metadata and stable local sorting", () => {
  assert.match(
    typesSource,
    /PodcastSearchResult = \{[\s\S]*?episodeCount\?: number \| null;[\s\S]*?genres: string\[\];[\s\S]*?latestReleaseAt\?: number \| null;/,
  );
  assert.match(rustSource, /primary_genre_name: Option<String>/);
  assert.match(rustSource, /release_date: Option<String>/);
  assert.match(rustSource, /normalize_apple_search_genres/);
  assert.match(rustSource, /genre\.eq_ignore_ascii_case\("podcasts"\) \|\| genre == "播客"/);
  assert.match(rustSource, /and_then\(parse_iso8601_millis\)/);
  assert.match(viewSource, /id: "relevance", label: "相关性"/);
  assert.match(viewSource, /id: "recent", label: "最近更新"/);
  assert.match(viewSource, /id: "episodes", label: "单集数量"/);
  assert.match(
    viewSource,
    /const sortedSearchResults = useMemo\([\s\S]*?sortPodcastSearchResults\(searchResults, searchSort\)/,
  );
  assert.match(
    viewSource,
    /function runAppleSearch\([\s\S]*?setSearchSort\("relevance"\)/,
  );
  assert.match(viewSource, /\{episodeCount\} 集/);
  assert.match(viewSource, /更新 \{formatEpisodeDate\(show\.latestReleaseAt\)\}/);
  assert.doesNotMatch(viewSource, /订阅数|更新频率/);
});

test("manual search highlighting stays text-only and themes do not expose hidden terms", () => {
  assert.match(
    viewSource,
    /setSearchHighlightQuery\(remember \? cleanQuery : ""\)/,
  );
  assert.match(
    viewSource,
    /function PodcastSearchHighlight\([\s\S]*?splitPodcastSearchMatch\(text, query\)[\s\S]*?<mark/,
  );
  assert.doesNotMatch(viewSource, /dangerouslySetInnerHTML/);
  assert.match(
    stylesSource,
    /\.podcast-search-sorts button\s*\{[\s\S]*?min-height:\s*40px/,
  );
  assert.match(
    stylesSource,
    /\.podcast-show-card-copy mark\s*\{[\s\S]*?background:/,
  );
  assert.match(
    stylesSource,
    /\.podcast-show-card-genres em:only-child\s*\{[\s\S]*?max-width:\s*100%/,
  );
});
 
test("discover search ignores IME composition commits and keeps RSS/history chrome honest", () => {
  assert.match(viewSource, /onCompositionStart=\{handlePodcastSearchCompositionStart\}/);
  assert.match(viewSource, /onCompositionEnd=\{handlePodcastSearchCompositionEnd\}/);
  assert.match(viewSource, /onKeyDown=\{handleSearchKeyDown\}/);
  assert.match(
    viewSource,
    /function searchApple\([\s\S]*?shouldBlockPodcastSearchCommit\([\s\S]*?void runAppleSearch\(query, \{ remember: true \}\)/,
  );
  assert.match(
    viewSource,
    /if \(remember && isRememberedPodcastSearchTerm\(cleanQuery\)\)/,
  );
  assert.match(viewSource, /className="podcast-search-history-clear"/);
  assert.doesNotMatch(viewSource, /<span>最近搜索<\/span>/);
  assert.match(viewSource, /className="podcast-discovery-search"/);
  assert.match(viewSource, /filterPodcastSearchHistory\(searchHistory, query\)/);
  assert.match(viewSource, /const showSearchHistory = searchFocused && !historyDismissed && suggestedHistory\.length > 0/);
  assert.match(viewSource, /<Presence show=\{showSearchHistory\} exitDurationMs=\{MOTION_DURATIONS\.micro\}>/);
  assert.match(viewSource, /onFocus=\{\(\) => setSearchFocused\(true\)\}/);
  assert.match(viewSource, /event\.key === "Escape"/);
  assert.match(
    stylesSource,
    /\.podcast-search-history \{[\s\S]*?position:\s*absolute[\s\S]*?border-top:\s*2px solid var\(--accent\)/,
  );
  assert.match(
    stylesSource,
    /\.podcast-page \.podcast-search-form input:focus-visible,[\s\S]*?outline:\s*0/,
  );
  assert.doesNotMatch(stylesSource, /\.podcast-rss-toggle::after/);
  assert.match(
    stylesSource,
    /\.podcast-rss-toggle\[aria-expanded="true"\]::after\s*\{[\s\S]*?content:\s*""/,
  );
});
