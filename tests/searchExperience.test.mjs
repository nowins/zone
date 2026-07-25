import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync("src/App.tsx", "utf8");
const headerSource = readFileSync("src/components/AppHeader.tsx", "utf8");
const titlebarSource = readFileSync("src/components/Titlebar.tsx", "utf8");
const searchSource = readFileSync("src/views/SearchResultsView.tsx", "utf8");
const baseCss = readFileSync("src/styles/base.css", "utf8");
const collectionCss = readFileSync("src/styles/collection.css", "utf8");

test("collection search opens a dedicated grouped result state", () => {
  assert.ok(appSource.includes("<SearchResultsView"));
  assert.ok(!appSource.includes("filteredTracks"));
  assert.ok(searchSource.includes('label="艺术家"'));
  assert.ok(searchSource.includes('label="专辑"'));
  assert.ok(searchSource.includes('label="歌曲"'));
  assert.ok(searchSource.includes('label="播放列表"'));
  assert.ok(searchSource.includes('aria-label="搜索结果筛选"'));
  assert.ok(collectionCss.includes(".search-results-layout"));
  assert.ok(collectionCss.includes("grid-template-columns: 176px minmax(0, 1fr)"));
});

test("search stays collapsed in the titlebar until invoked", () => {
  const searchRule = cssRule(baseCss, ".titlebar-search");
  const expandedRule = cssRule(baseCss, ".titlebar-search.expanded");

  assert.ok(!appSource.includes("collection-search-slot"));
  assert.ok(!headerSource.includes("搜索音乐"));
  assert.ok(!headerSource.includes("app-utilities"));
  assert.ok(titlebarSource.includes("const searchExpanded = searchActive && searchOpen"));
  assert.ok(titlebarSource.includes('className={`titlebar-search${searchExpanded ? " expanded" : ""}${hasQuery ? " has-query" : ""}`}'));
  assert.ok(titlebarSource.includes('event.key.toLowerCase() === "f"'));
  assert.ok(titlebarSource.includes("event.ctrlKey || event.metaKey"));
  assert.ok(titlebarSource.includes('window.addEventListener("keydown", handleSearchShortcut, true)'));
  assert.ok(titlebarSource.includes('event.key === "Escape"'));
  assert.ok(titlebarSource.includes("onPointerLeave={collapseSearch}"));
  assert.ok(titlebarSource.includes('aria-label="关闭搜索"'));
  assert.ok(titlebarSource.includes('aria-controls="collection-search-results"'));
  assert.ok(titlebarSource.includes('autoComplete="off"'));
  assert.ok(titlebarSource.includes('aria-autocomplete="none"'));
  assert.ok(titlebarSource.includes('placeholder="搜索音乐、艺术家、专辑…"'));
  assert.ok(appSource.includes('onOpenSearch={() => navigatePage("collection")}'));
  assert.ok(searchRule.includes("width: 42px"));
  assert.ok(expandedRule.includes("border-bottom-color"));
  assert.ok(!expandedRule.includes("border: 1px solid"));
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
  for (const copy of ["筛选", "全部", "艺术家", "专辑", "歌曲", "播放列表", "查看全部", "没有找到"]) {
    assert.ok(searchSource.includes(copy), `missing Chinese search copy: ${copy}`);
  }
});

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[1];
}
