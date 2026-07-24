import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync("src/App.tsx", "utf8");
const headerSource = readFileSync("src/components/AppHeader.tsx", "utf8");
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

test("the search field stays quiet, clearable, and separated from window controls", () => {
  const utilitiesRule = cssRule(baseCss, ".app-utilities");
  const searchRule = cssRule(baseCss, ".search-box");

  assert.ok(utilitiesRule.includes("margin-right: clamp(112px, 10vw, 150px)"));
  assert.ok(searchRule.includes("height: 30px"));
  assert.ok(searchRule.includes("border: 1px solid rgba(247, 242, 246, 0.13)"));
  assert.ok(headerSource.includes('event.key === "Escape"'));
  assert.ok(headerSource.includes('aria-label="清除搜索"'));
  assert.ok(headerSource.includes('aria-controls="collection-search-results"'));
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
