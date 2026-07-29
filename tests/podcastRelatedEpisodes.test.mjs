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
].map((path) => readFileSync(path, "utf8")).join("\n");
const stylesSource = readFileSync("src/styles/podcasts.css", "utf8");
const rustSource = [
  "src-tauri/src/podcast/mod.rs",
  "src-tauri/src/podcast/commands.rs",
  "src-tauri/src/podcast/query.rs",
].map((path) => readFileSync(path, "utf8")).join("\n");

test("episode detail loads a bounded related list without polluting the show browser", () => {
  assert.match(viewSource, /useState<PodcastEpisode\[\]>\(\[\]\)/);
  assert.match(viewSource, /const relatedEpisodeRequestRef = useRef\(0\)/);
  const loadStart = viewSource.indexOf("const loadRelatedEpisodes = useCallback");
  const loadEnd = viewSource.indexOf("\n\n  const loadEpisodeDetail", loadStart);
  const loadSource = viewSource.slice(loadStart, loadEnd);
  assert.match(loadSource, /podcastApi\.listRelatedEpisodes\(episodeId, 6\)/);
  assert.match(loadSource, /relatedEpisodeRequestRef\.current !== requestId/);
  assert.match(loadSource, /\.filter\(\(episode\) =>[\s\S]*?episode\.id !== episodeId/);
  assert.match(loadSource, /\.slice\(0, 6\)/);
  assert.match(viewSource, /title="该节目的其他单集"/);
  assert.match(viewSource, /actionLabel="查看全部"/);
  assert.match(viewSource, /onAction=\{\(\) => void openEpisodeShow\(\)\}/);
  assert.match(
    viewSource,
    /relatedState === "loading"[\s\S]*?PodcastLoading[\s\S]*?正在整理其他单集/,
  );
  assert.match(
    viewSource,
    /relatedState === "error"[\s\S]*?暂时无法读取其他单集/,
  );
  assert.match(stylesSource, /\.podcast-detail-related/);
  assert.match(stylesSource, /\.podcast-home-episodes/);
  assert.match(rustSource, /podcast_list_related_episodes/);
  assert.match(rustSource, /PODCAST_RELATED_EPISODE_DEFAULT_LIMIT/);
  assert.match(rustSource, /PODCAST_RELATED_EPISODE_MAX_LIMIT/);
});

test("related episode rows retain normal playback actions and an all-episodes path", () => {
  assert.match(viewSource, /displayedRelatedEpisodes/);
  assert.match(
    viewSource,
    /displayedRelatedEpisodes\.map\(\(episode\) =>[\s\S]*?<EpisodeRow/,
  );
  assert.match(
    viewSource,
    /onOpen=\{\(\) => openEpisodeDetail\(episode\)\}/,
  );
});

test("switching between related episodes preserves a now-playing return session", () => {
  const openStart = viewSource.indexOf("function openEpisodeDetail(");
  const openEnd = viewSource.indexOf("\n\n  function closeEpisodeDetail", openStart);
  const openSource = viewSource.slice(openStart, openEnd);
  assert.match(openSource, /preserveNowPlayingReturn/);
  assert.match(openSource, /episodeReturnToNowPlaying/);
});
