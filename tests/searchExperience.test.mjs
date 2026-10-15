import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = [
  "src/app/podcastPlaybackSettings.ts",
  "src/hooks/useNavigation.ts",
  "src/hooks/useCollectionNavigation.ts",
  "src/views/CollectionView.tsx",
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
  assert.ok(appSource.includes("searching ? <SearchResultsView"));
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

test("compact collection chrome shares one category/search row without repeated music headings", () => {
  const source = readFileSync("src/views/CollectionView.tsx", "utf8");
  assert.ok(source.includes("collection-toolbar"));
  assert.ok(source.includes("collection-categories"));
  assert.ok(source.includes("<CollectionSearchField"));
  assert.ok(!source.includes("collection-chrome-label"));
  assert.ok(source.includes('aria-label="收藏视图"'));
  assert.ok(searchFieldSource.includes('aria-label="搜索音乐"'));
  assert.ok(searchFieldSource.includes('aria-label="清除搜索"'));
  assert.ok(!titlebarSource.includes("titlebar-search"));
  assert.ok(!headerSource.includes("搜索音乐"));
});

test("all search objects share collection history instead of independent view mutations", () => {
  const source = readFileSync("src/views/CollectionView.tsx", "utf8");
  assert.ok(source.includes("props.onOpen(artistReference(artist))"));
  assert.ok(source.includes("props.onOpen(albumReference(album))"));
  assert.ok(source.includes('props.onOpen({ kind: "playlist", id })'));
  assert.ok(searchSource.includes("context.navigation.patch({ filter })"));
  assert.ok(searchSource.includes("playbackTracks={results.tracks}"));
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

test("search results use a palette-aware compact scrollbar without native arrow buttons", () => {
  const scrollRule = cssRule(collectionCss, ".search-results-scroll");

  assert.ok(scrollRule.includes("scrollbar-width: thin"));
  assert.ok(scrollRule.includes("scrollbar-color: rgba(var(--surface-ink), 0.18) transparent"));
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
