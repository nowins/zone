import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewSource = [
  "src/views/PodcastView.tsx",
  "src/views/podcast/usePodcastViewModel.ts",
  "src/views/podcast/api.ts",
  "src/views/podcast/screens/ListenScreen.tsx",
  "src/views/podcast/screens/DiscoverScreen.tsx",
  "src/views/podcast/screens/LibraryScreen.tsx",
  "src/views/podcast/screens/PlaylistScreen.tsx",
  "src/views/podcast/screens/ShowScreen.tsx",
  "src/views/podcast/screens/EpisodeScreen.tsx",
  "src/views/podcast/constants.ts",
  "src/views/podcast/cache.ts",
  "src/views/podcast/format.ts",
  "src/views/podcast/components/EpisodeRows.tsx",
].map((path) => readFileSync(path, "utf8")).join("\n");
const podcastPrimitivesSource = readFileSync(
  "src/views/podcast/components/primitives.tsx",
  "utf8",
);
const stylesSource = readFileSync("src/styles/podcasts.css", "utf8");
const motionSource = readFileSync("src/styles/motion.css", "utf8");
const rustSource = [
  "src-tauri/src/podcast/commands.rs",
  "src-tauri/src/podcast/mod.rs",
  "src-tauri/src/podcast/chapters.rs",
  "src-tauri/src/podcast/downloads.rs",
].map((path) => readFileSync(path, "utf8")).join("\n");

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
  assert.match(
    viewSource,
    /PREVIEW_FEED_CACHE_TTL_MS\s*=\s*30\s*\*\s*60\s*\*\s*1_000/,
  );
  assert.match(
    viewSource,
    /cacheEntryIsFresh\(\s*cachedPreviewEntry,\s*PREVIEW_FEED_CACHE_TTL_MS/,
  );
  assert.match(
    viewSource,
    /cachedDocument\?\.stale[\s\S]*?STALE_CHAPTER_CACHE_TTL_MS[\s\S]*?CHAPTER_CACHE_TTL_MS/,
  );
  assert.match(
    viewSource,
    /setChapterDocument\(cachedDocument\);[\s\S]*?podcastApi.getEpisodeChapters/,
  );
  assert.match(
    viewSource,
    /loadEpisodeChapters\(\s*displayedEpisodeDetail\.episode\.id,\s*true/,
  );
});

test("content loading pairs a delayed reveal with the Metro orbit indicator", () => {
  const loadingStart = podcastPrimitivesSource.indexOf("function PodcastLoading(");
  const indicatorStart = podcastPrimitivesSource.indexOf(
    "\nfunction PodcastActivityIndicator(",
    loadingStart,
  );
  const loadingSource = podcastPrimitivesSource.slice(
    loadingStart,
    indicatorStart,
  );
  assert.match(loadingSource, /podcast-loading-state/);
  assert.match(loadingSource, /PodcastActivityIndicator/);
  assert.doesNotMatch(loadingSource, /LoaderCircle|podcast-spinner/);
  assert.match(
    stylesSource,
    /\.podcast-loading-state\s*\{[\s\S]*?podcast-loading-reveal[\s\S]*?backwards/,
  );
  assert.match(
    stylesSource,
    /animation:\s*podcast-metro-orbit\s+var\(--motion-loader,\s*4500ms\)/,
  );
  assert.match(
    stylesSource,
    /@keyframes podcast-metro-orbit\s*\{[\s\S]*?rotate\(720deg\)[\s\S]*?\}/,
  );
  assert.doesNotMatch(
    stylesSource.slice(
      stylesSource.indexOf("@keyframes podcast-metro-orbit"),
      stylesSource.indexOf("@keyframes podcast-spin"),
    ),
    /width|height|margin|padding/,
  );
  assert.match(motionSource, /\.podcast-activity-indicator > span/);
});

test("podcast downloads expose throttled byte progress instead of an indefinite spinner", () => {
  assert.match(
    rustSource,
    /PODCAST_DOWNLOAD_PROGRESS_BYTE_INTERVAL:\s*u64\s*=\s*2\s*\*\s*1024\s*\*\s*1024/,
  );
  assert.match(
    rustSource,
    /while let Some\(chunk\)[\s\S]*?progressed_bytes[\s\S]*?mark_download_started\(/,
  );
  assert.match(
    viewSource,
    /window\.setInterval\([\s\S]*?PODCAST_DOWNLOAD_PROGRESS_POLL_MS/,
  );
  assert.match(
    viewSource,
    /podcastApi\.getEpisodeDetail\([\s\S]*?applyEpisodeUpdate\(detail\.episode\)/,
  );
  assert.match(viewSource, /function podcastDownloadProgressLabel\(/);
  assert.match(viewSource, /className="podcast-download-progress"/);
});
