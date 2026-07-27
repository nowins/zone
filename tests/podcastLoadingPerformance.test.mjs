import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewSource = readFileSync("src/views/PodcastView.tsx", "utf8");
const stylesSource = readFileSync("src/styles/podcasts.css", "utf8");
const motionSource = readFileSync("src/styles/motion.css", "utf8");
const rustSource = readFileSync("src-tauri/src/podcast.rs", "utf8");

test("podcast discovery and search keep cached content ahead of network refresh", () => {
  assert.match(viewSource, /const searchCache = new Map/);
  assert.match(
    viewSource,
    /const cached = discoveryCache;[\s\S]*?setDiscoveryShows\(cached\.shows\);[\s\S]*?setDiscoveryState\("ready"\)/,
  );
  assert.match(
    viewSource,
    /const cached = searchCache\.get\(cacheKey\);[\s\S]*?setSearchResults\(cached\.results\);[\s\S]*?setSearchState\("ready"\)/,
  );
  assert.match(
    viewSource,
    /if \(cached\) \{[\s\S]*?网络暂时不可用，已保留上次搜索结果/,
  );
});

test("preview and chapter requests reuse durable caches before networking", () => {
  const previewCommandStart = rustSource.indexOf(
    "pub async fn podcast_preview_feed(",
  );
  const subscribeCommandStart = rustSource.indexOf(
    "\n#[tauri::command]",
    previewCommandStart + 1,
  );
  const previewCommand = rustSource.slice(
    previewCommandStart,
    subscribeCommandStart,
  );
  assert.ok(
    previewCommand.indexOf("get_recent_preview(")
      < previewCommand.indexOf("fetch_and_parse_feed("),
  );
  assert.match(rustSource, /PODCAST_CHAPTER_REFRESH_INTERVAL/);
  assert.match(
    rustSource,
    /resource\.fetched_at\.is_some_and[\s\S]*?return Ok\(cached\);[\s\S]*?refresh_external_chapter_resource/,
  );
  assert.match(viewSource, /chapterDocumentCache\.get\(episodeId\)/);
});

test("content loading uses a delayed opacity signal instead of another spinner", () => {
  const loadingStart = viewSource.indexOf("function PodcastLoading(");
  const indicatorStart = viewSource.indexOf(
    "\nfunction PodcastActivityIndicator(",
    loadingStart,
  );
  const loadingSource = viewSource.slice(loadingStart, indicatorStart);
  assert.match(loadingSource, /podcast-loading-state/);
  assert.match(loadingSource, /PodcastActivityIndicator/);
  assert.doesNotMatch(loadingSource, /LoaderCircle|podcast-spinner/);
  assert.match(
    stylesSource,
    /\.podcast-loading-state\s*\{[\s\S]*?podcast-loading-reveal[\s\S]*?backwards/,
  );
  assert.match(
    stylesSource,
    /@keyframes podcast-loading-pulse\s*\{[\s\S]*?opacity:[\s\S]*?\}/,
  );
  assert.doesNotMatch(
    stylesSource.slice(
      stylesSource.indexOf("@keyframes podcast-loading-pulse"),
      stylesSource.indexOf("@keyframes podcast-spin"),
    ),
    /transform|width|height|margin|padding/,
  );
  assert.match(motionSource, /\.podcast-activity-indicator > span/);
});
