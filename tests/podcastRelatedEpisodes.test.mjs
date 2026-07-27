import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewSource = readFileSync("src/views/PodcastView.tsx", "utf8");
const stylesSource = readFileSync("src/styles/podcasts.css", "utf8");
const rustSource = readFileSync("src-tauri/src/podcast.rs", "utf8");

test("episode detail loads a bounded related list without polluting the show browser", () => {
  assert.match(viewSource, /useState<PodcastEpisode\[\]>\(\[\]\)/);
  assert.match(viewSource, /const relatedEpisodeRequestRef = useRef\(0\)/);
  const loadStart = viewSource.indexOf("const loadRelatedEpisodes = useCallback");
  const loadEnd = viewSource.indexOf("\n\n  const loadEpisodeDetail", loadStart);
  const loadSource = viewSource.slice(loadStart, loadEnd);
  assert.match(loadSource, /"podcast_list_related_episodes"/);
  assert.match(loadSource, /\{ episodeId, limit: 6 \}/);
  assert.match(loadSource, /relatedEpisodeRequestRef\.current !== requestId/);
  assert.match(loadSource, /\.filter\(\(episode\) =>[\s\S]*?episode\.id !== episodeId/);
  assert.match(loadSource, /\.slice\(0, 6\)/);
  assert.doesNotMatch(loadSource, /setEpisodes\(/);
});

test("related episodes use a dedicated bounded SQLite query", () => {
  assert.match(rustSource, /PODCAST_RELATED_EPISODE_MAX_LIMIT: usize = 12/);
  assert.match(rustSource, /pub async fn podcast_list_related_episodes\(/);
  assert.match(
    rustSource,
    /fn list_related_episodes\([\s\S]*?ensure_episode_exists\(&connection, episode_id\)/,
  );
  assert.match(rustSource, /WHERE e\.id != \?1[\s\S]*?TRIM\(e\.enclosure_url\) != ''/);
  assert.match(
    rustSource,
    /COALESCE\(e\.published_at, e\.first_seen_at\) DESC,[\s\S]*?LIMIT \?2/,
  );
});

test("related episode rows retain normal playback actions and an all-episodes path", () => {
  assert.match(viewSource, /title="该节目的其他单集"/);
  assert.match(viewSource, /actionLabel="查看全部"/);
  assert.match(viewSource, /onAction=\{\(\) => void openEpisodeShow\(\)\}/);
  assert.doesNotMatch(
    viewSource,
    /title="该节目的其他单集"\s+count=/,
  );
  assert.match(
    viewSource,
    /displayedRelatedEpisodes\.map\(\(episode\) => \([\s\S]*?<EpisodeRow[\s\S]*?openEpisodeDetail\(episode\)[\s\S]*?playEpisode\(episode\)[\s\S]*?downloadEpisode\(episode\)[\s\S]*?showEpisodeMenu\(event, episode\)/,
  );
  assert.match(
    stylesSource,
    /\.podcast-detail-related\s*\{[\s\S]*?width:\s*min\(980px, 100%\)/,
  );
});

test("switching between related episodes preserves a now-playing return session", () => {
  const openStart = viewSource.indexOf("function openEpisodeDetail(");
  const openEnd = viewSource.indexOf("\n\n  function closeEpisodeDetail", openStart);
  const openSource = viewSource.slice(openStart, openEnd);
  assert.match(
    openSource,
    /screen === "episode" && episodeReturnToNowPlaying/,
  );
  assert.match(
    openSource,
    /if \(!preserveNowPlayingReturn\) \{[\s\S]*?episodeReturnSessionRef\.current = null/,
  );
});
