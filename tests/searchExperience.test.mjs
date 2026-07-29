import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = [
  "src/app/podcastPlaybackSettings.ts",
  "src/hooks/useNavigation.ts",
  "src/hooks/useMusicLibrary.ts",
  "src/hooks/usePodcastPlayback.ts",
  "src/hooks/usePlaybackControls.ts",
  "src/hooks/useAudioEngine.ts",
  "src/hooks/usePlaylists.ts",
  "src/App.tsx",
].map((path) => readFileSync(path, "utf8")).join("\n");
const headerSource = readFileSync("src/components/AppHeader.tsx", "utf8");
const titlebarSource = readFileSync("src/components/Titlebar.tsx", "utf8");
const searchFieldSource = readFileSync("src/components/CollectionSearchField.tsx", "utf8");
const searchSource = readFileSync("src/views/SearchResultsView.tsx", "utf8");
const collectionCss = readFileSync("src/styles/collection.css", "utf8");
const baseCss = readFileSync("src/styles/base.css", "utf8");

test("collection search opens a dedicated grouped result state", () => {
  assert.ok(appSource.includes("<SearchResultsView"));
  assert.ok(appSource.includes("showSearchResults"));
  assert.ok(appSource.includes('resolveSearchSurface(query, searchMode) === "results"'));
  assert.ok(!appSource.includes("filteredTracks"));
  assert.ok(searchSource.includes('label="艺术家"'));
  assert.ok(searchSource.includes('label="专辑"'));
  assert.ok(searchSource.includes('label="歌曲"'));
  assert.ok(searchSource.includes('label="播放列表"'));
  assert.ok(searchSource.includes('aria-label="搜索结果筛选"'));
  assert.ok(collectionCss.includes(".search-results-layout"));
  assert.ok(collectionCss.includes("grid-template-columns: 176px minmax(0, 1fr)"));
});

test("Zune collection chrome puts music+search above title+view tabs", () => {
  assert.ok(appSource.includes("<CollectionSearchField"));
  assert.ok(appSource.includes("collection-chrome"));
  assert.ok(appSource.includes("collection-chrome-label"));
  assert.ok(appSource.includes("collection-chrome-label"));
  assert.ok(appSource.includes("音乐"));
  assert.ok(appSource.includes("collection-header-main"));
  assert.ok(appSource.includes('aria-label="收藏视图"'));
  assert.ok(appSource.includes("collection-band"));
  assert.ok(collectionCss.includes(".collection-band"));
  assert.ok(collectionCss.includes("radial-gradient"));
  assert.ok(collectionCss.includes(".collection-chrome"));
  assert.ok(collectionCss.includes(".collection-header-main"));
  // Settings keeps plain content-band without the collection wash class.
  const settingsSource = readFileSync("src/views/SettingsView.tsx", "utf8");
  assert.ok(settingsSource.includes('className="content-band settings-page"'));
  assert.ok(!settingsSource.includes("collection-band"));
  assert.ok(searchFieldSource.includes('placeholder="搜索音乐、艺术家、专辑…"'));
  assert.ok(searchFieldSource.includes('aria-label="搜索音乐"'));
  assert.ok(searchFieldSource.includes('aria-label="清除搜索"'));
  assert.ok(searchFieldSource.includes("返回结果"));
  assert.ok(searchFieldSource.includes("aria-controls={hasQuery ? resultsId : undefined}"));
  assert.ok(searchFieldSource.includes('autoComplete="off"'));
  assert.ok(collectionCss.includes(".collection-search-field"));
  assert.ok(collectionCss.includes("border-bottom: 1px solid"));
  assert.ok(!collectionCss.includes("width: clamp(210px"), "collection search must not use titlebar expand widths");
  assert.ok(!baseCss.includes(".titlebar-search"), "titlebar search chrome is removed");
  assert.ok(!titlebarSource.includes("titlebar-search"));
  assert.ok(!titlebarSource.includes("onPointerLeave"));
  assert.ok(!titlebarSource.includes("searchOpen"));
  assert.ok(!titlebarSource.includes("onQuery"));
  assert.ok(!headerSource.includes("搜索音乐"));
  assert.ok(!headerSource.includes("app-utilities"));
});

test("search session supports browse drill-in without clearing the query", () => {
  assert.ok(appSource.includes('useState<CollectionSearchMode>("results")'));
  assert.ok(appSource.includes('setSearchMode("browse")'));
  assert.ok(appSource.includes('setSearchMode("results")'));
  assert.ok(appSource.includes("showReturnToResults={query.trim().length > 0 && searchMode === \"browse\"}"));
  assert.ok(!appSource.includes("setQuery(\"\")") || appSource.includes("clearCollectionSearch"));
  // openSearch* must not clear the query on drill-in
  const openArtist = appSource.slice(
    appSource.indexOf("function openSearchArtist"),
    appSource.indexOf("function openSearchAlbum"),
  );
  assert.ok(!openArtist.includes("setQuery"), "artist drill-in must keep the query");
  assert.ok(openArtist.includes('setSearchMode("browse")'));
});

test("Ctrl/Cmd+F and Esc are owned by App collection search", () => {
  assert.ok(appSource.includes('event.key.toLowerCase() === "f"'));
  assert.ok(appSource.includes("event.ctrlKey || event.metaKey"));
  assert.ok(appSource.includes("focusCollectionSearch"));
  assert.ok(appSource.includes('event.key !== "Escape"'));
  assert.ok(appSource.includes("clearCollectionSearch"));
  assert.ok(titlebarSource.includes("onOpenSettings"));
  assert.ok(!titlebarSource.includes("handleSearchShortcut"));
});

test("search results use a dark compact scrollbar without native arrow buttons", () => {
  const scrollRule = cssRule(collectionCss, ".search-results-scroll");

  assert.ok(scrollRule.includes("scrollbar-width: thin"));
  assert.ok(scrollRule.includes("scrollbar-color: rgba(247, 242, 246, 0.18) transparent"));
  assert.ok(collectionCss.includes(".search-results-scroll::-webkit-scrollbar-track"));
  assert.ok(collectionCss.includes(".search-results-scroll::-webkit-scrollbar-thumb"));
  assert.ok(collectionCss.includes(".search-results-scroll::-webkit-scrollbar-button"));
  assert.ok(collectionCss.includes("display: none"));
});

test("search UI copy is consistently Chinese", () => {
  for (const copy of ["筛选", "全部", "艺术家", "专辑", "歌曲", "播放列表", "查看全部", "没有找到", "返回结果", "清除搜索"]) {
    const haystack = `${searchSource}\n${searchFieldSource}`;
    assert.ok(haystack.includes(copy), `missing Chinese search copy: ${copy}`);
  }
});

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[1];
}
