import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  findActivePodcastChapterIndex,
} from "../.tmp/visualizer-tests/utils/podcastChapters.js";

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
const typesSource = readFileSync("src/types.ts", "utf8");
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
  "src/views/podcast/components/EpisodeDetail.tsx",
].map((path) => readFileSync(path, "utf8")).join("\n");
const stylesSource = readFileSync("src/styles/podcasts.css", "utf8");
const modelSource = readFileSync("src/views/podcast/usePodcastViewModel.ts", "utf8");
const rustSource = [
  "src-tauri/src/podcast/mod.rs",
  "src-tauri/src/podcast/feed_parse.rs",
  "src-tauri/src/podcast/chapters.rs",
  "src-tauri/src/podcast/commands.rs",
].map((path) => readFileSync(path, "utf8")).join("\n");

test("active chapter selection respects explicit ends and adjacent starts", () => {
  const chapters = [
    { startSeconds: 0, endSeconds: null, title: "开场" },
    { startSeconds: 30, endSeconds: 45, title: "短章节" },
    { startSeconds: 60, endSeconds: null, title: "结尾" },
  ];
  assert.equal(findActivePodcastChapterIndex(chapters, 0), 0);
  assert.equal(findActivePodcastChapterIndex(chapters, 29.9), 0);
  assert.equal(findActivePodcastChapterIndex(chapters, 30), 1);
  assert.equal(findActivePodcastChapterIndex(chapters, 45), -1);
  assert.equal(findActivePodcastChapterIndex(chapters, 60), 2);
  assert.equal(findActivePodcastChapterIndex(chapters, Number.NaN), -1);
});

test("chapter sources are discovered and cached behind a bounded native command", () => {
  assert.match(rustSource, /NsReader::from_reader\(bytes\)/);
  assert.match(rustSource, /PODCAST_NAMESPACE_COMPAT_URI/);
  assert.match(rustSource, /PODLOVE_SIMPLE_CHAPTERS_NAMESPACE_URI/);
  assert.match(rustSource, /PODCAST_CHAPTER_RESPONSE_LIMIT:\s*usize\s*=\s*1024\s*\*\s*1024/);
  assert.match(rustSource, /PODCAST_CHAPTER_MAX_COUNT:\s*usize\s*=\s*1_000/);
  assert.match(rustSource, /pub async fn podcast_get_episode_chapters\(/);
  assert.match(rustSource, /send_public_get_with_headers\(/);
  assert.match(rustSource, /header::IF_NONE_MATCH/);
  assert.match(rustSource, /StatusCode::NOT_MODIFIED/);
  assert.match(rustSource, /validate_identifier\(episode_id\)/);
});

test("episode detail loads chapters only after the disclosure is opened", () => {
  assert.match(typesSource, /export type PodcastChapterDocument\s*=/);
  assert.match(typesSource, /hasChapters:\s*boolean/);
  const loadStart = viewSource.indexOf("const loadEpisodeChapters = useCallback");
  const loadEnd = viewSource.indexOf("\n\n  const loadEpisodeDetail", loadStart);
  const loadSource = viewSource.slice(loadStart, loadEnd);
  assert.match(loadSource, /podcastApi\.getEpisodeChapters\(episodeId\)/);
  assert.match(loadSource, /chapterRequestRef\.current !== requestId/);
  const detailLoadStart = viewSource.indexOf("const loadEpisodeDetail = useCallback");
  const detailLoadEnd = viewSource.indexOf("\n\n  const applyEpisodeUpdate", detailLoadStart);
  // Scope the check to usePodcastViewModel: api.ts (also in viewSource) wraps
  // getEpisodeChapters after loadEpisodeDetail, which would otherwise fall
  // inside the naive slice boundary and trip a false positive.
  const detailInModel = modelSource.slice(
    modelSource.indexOf("const loadEpisodeDetail = useCallback"),
  );
  const detailBody = detailInModel.slice(0, detailInModel.indexOf("\n  const "));
  assert.doesNotMatch(detailBody, /getEpisodeChapters|podcast_get_episode_chapters/);
  assert.match(viewSource, /"podcast_get_episode_chapters"/);
  assert.match(
    viewSource,
    /function toggleEpisodeChapters\(\)[\s\S]*?setChaptersOpen\(true\)[\s\S]*?loadEpisodeChapters/,
  );
});

test("chapter rows are keyboard buttons with current-time feedback", () => {
  assert.match(viewSource, /className="podcast-chapter-disclosure"/);
  assert.match(viewSource, /aria-expanded=\{chaptersOpen\}/);
  assert.match(viewSource, /<strong>章节<\/strong>/);
  assert.match(viewSource, /aria-current=\{current \? "true" : undefined\}/);
  assert.match(viewSource, /onPlayChapter\(chapter\.startSeconds\)/);
  assert.match(viewSource, /当前显示上次成功读取的章节/);
  assert.match(stylesSource, /\.podcast-chapter-list button\s*\{[\s\S]*?min-height:\s*48px/);
  assert.match(
    stylesSource,
    /transition:\s*[\s\S]*?var\(--motion-micro\)[\s\S]*?var\(--motion-press\)/,
  );
});

test("chapter seeks reuse the shared audio and distinguish explicit starts from resume", () => {
  assert.match(viewSource, /onPlayEpisodeAt\(/);
  assert.match(appSource, /const pendingPodcastStartRef = useRef/);
  assert.match(
    appSource,
    /explicitStart[\s\S]*?pendingPodcastResumeRef\.current = \{[\s\S]*?explicit:\s*explicitStart/,
  );
  assert.match(
    appSource,
    /const restoredPosition = resolvePodcastResumePosition\(pending, episode, nextDuration\)/,
  );
  assert.match(appSource,/podcast\.resolvePodcastIntro\?\.\(restoredPosition,nextDuration,Boolean\(pending\.explicit\)\)/);
  assert.equal((appSource.match(/<audio\b/g) ?? []).length, 1);
  assert.doesNotMatch(viewSource, /<audio\b/);
});
