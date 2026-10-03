import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
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
const appHeaderSource = readFileSync("src/components/AppHeader.tsx", "utf8");
const playerBarSource = readFileSync("src/components/PlayerBar.tsx", "utf8");
const podcastPlayerBarSource = readFileSync("src/components/PodcastPlayerBar.tsx", "utf8");
const podcastViewSource = [
  "src/views/PodcastView.tsx",
  "src/views/podcast/usePodcastViewModel.ts",
  "src/views/podcast/api.ts",
  "src/views/podcast/screens/ListenScreen.tsx",
  "src/views/podcast/screens/DiscoverScreen.tsx",
  "src/views/podcast/screens/LibraryScreen.tsx",
  "src/views/podcast/screens/PlaylistScreen.tsx",
  "src/views/podcast/screens/ShowScreen.tsx",
  "src/views/podcast/screens/EpisodeScreen.tsx",
  "src/views/podcast/types.ts",
  "src/views/podcast/constants.ts",
  "src/views/podcast/cache.ts",
  "src/views/podcast/episodeModel.ts",
  "src/views/podcast/preferences.ts",
  "src/views/podcast/format.ts",
  "src/views/podcast/components/primitives.tsx",
  "src/views/podcast/components/EpisodeRows.tsx",
  "src/views/podcast/components/QueueEpisodeRow.tsx",
  "src/views/podcast/components/EpisodeDetail.tsx",
  "src/views/podcast/components/ContinueCard.tsx",
  "src/views/podcast/components/ShowCards.tsx",
  "src/views/podcast/components/Dialogs.tsx",
].map((path) => readFileSync(path, "utf8")).join("\n");
const podcastNowPlayingSource = readFileSync("src/views/PodcastNowPlayingView.tsx", "utf8");
const podcastArtworkSource = readFileSync("src/utils/podcastArtwork.ts", "utf8");
const podcastPlaybackSource = readFileSync("src/utils/podcastPlayback.ts", "utf8");
const baseCss = readFileSync("src/styles/base.css", "utf8");
const podcastCss = readFileSync("src/styles/podcasts.css", "utf8");
const podcastNowPlayingCss = readFileSync("src/styles/podcast-now-playing.css", "utf8");
const motionCss = readFileSync("src/styles/motion.css", "utf8");
const nowPlayingSource = readFileSync("src/views/NowPlayingView.tsx", "utf8");
const typesSource = readFileSync("src/types.ts", "utf8");
const rustEntrySource = readFileSync("src-tauri/src/lib.rs", "utf8");
const podcastRustSource = [
  "src-tauri/src/podcast/store.rs",
  "src-tauri/src/podcast/feed_parse.rs",
  "src-tauri/src/podcast/downloads.rs",
  "src-tauri/src/podcast/network.rs",
  "src-tauri/src/db/schema.rs",
].map((path) => readFileSync(path, "utf8")).join("\n");

const frontendSources = sourceFiles("src", /\.(?:ts|tsx)$/);
const allFrontendSource = frontendSources.map(({ source }) => source).join("\n");
const invokeHandlerSource =
  /generate_handler!\s*\[([\s\S]*?)\]\s*\)/.exec(rustEntrySource)?.[1] ?? "";

const PODCAST_COMMANDS = [
  "podcast_browse_apple",
  "podcast_list_home",
  "podcast_preview_feed",
  "podcast_search_apple",
  "podcast_set_following",
  "podcast_subscribe",
  "podcast_list_feeds",
  "podcast_list_episodes",
  "podcast_list_related_episodes",
  "podcast_get_episode_detail",
  "podcast_get_episode_chapters",
  "podcast_cache_artwork",
  "podcast_set_episode_saved",
  "podcast_list_saved_episodes",
  "podcast_set_episode_played",
  "podcast_list_queue",
  "podcast_queue_add",
  "podcast_queue_remove",
  "podcast_queue_reorder",
  "podcast_queue_clear",
  "podcast_refresh_feeds",
  "podcast_download_episode",
  "podcast_delete_episode_download",
  "podcast_save_progress",
];

test("podcast playback reuses the app's single audio element", () => {
  const audioOwners = frontendSources
    .filter(({ source }) => /<audio\b/.test(source))
    .map(({ path }) => path);

  assert.deepEqual(audioOwners, ["src/App.tsx"]);
  assert.equal(occurrences(appSource, /<audio\b/g), 1);
  assert.equal(occurrences(allFrontendSource, /\bnew\s+Audio\s*\(/g), 0);
  includes(appSource, /ref=\{audioRef\}/, "the shared audio element must keep audioRef");
  excludes(podcastViewSource, /<audio\b|\bnew\s+Audio\s*\(/, "PodcastView must not own audio");
  excludes(podcastPlayerBarSource, /<audio\b|\bnew\s+Audio\s*\(/, "the podcast bar must not own audio");
});

test("podcasts are a peer page wired to the formal discovery and library command chain", () => {
  includes(typesSource, /type AppPage\s*=[^;]*"podcasts"/, "AppPage must include podcasts");
  includes(appHeaderSource, /onNavigate\("podcasts", event\.detail > 0\)/, "the primary navigation must open podcasts and distinguish keyboard activation");
  includes(appHeaderSource, />\s*播客\s*</, "the podcast navigation label must be Chinese");
  includes(appSource, /page\s*===\s*"podcasts"/, "App must render a podcasts page branch");
  includes(appSource, /<PodcastView\b/, "App must mount PodcastView");

  for (const command of PODCAST_COMMANDS) {
    assert.ok(
      hasInvoke(allFrontendSource, command),
      `frontend does not invoke ${command}`,
    );
    includes(
      invokeHandlerSource,
      new RegExp(`\\b${command}\\b`),
      `Tauri does not register ${command}`,
    );
  }
});

test("podcasts open on content, keep search secondary, and separate play from download", () => {
  includes(
    podcastViewSource,
    /useState<PodcastScreen>\(\s*restoredSession\?\.screen\s*\?\?\s*"listen"/,
    "podcasts must restore their prior surface and otherwise open on the listening home",
  );
  includes(
    podcastViewSource,
    /setPodcastSessionSnapshot\(\{[\s\S]{0,420}\bscreen,[\s\S]{0,420}\bselectedEpisodeDetail,/,
    "podcasts must preserve their navigation and episode context while full-screen playback is open",
  );
  for (const label of ["收听", "发现", "资料库", "继续收听", "中国区热门节目"]) {
    includes(podcastViewSource, new RegExp(label), `missing formal podcast label: ${label}`);
  }
  excludes(podcastViewSource, /播客实验|下载并播放/, "probe copy must not remain in the formal experience");

  const listenScreenSource = readFileSync(
    "src/views/podcast/screens/ListenScreen.tsx",
    "utf8",
  );
  const discoverSurface = readFileSync(
    "src/views/podcast/screens/DiscoverScreen.tsx",
    "utf8",
  );
  excludes(
    listenScreenSource,
    /DiscoveryShelf|中国区热门节目/,
    "the listening home must not duplicate the discovery catalog",
  );
  includes(
    listenScreenSource,
    /!hasListenContent[\s\S]{0,520}<PodcastEmpty[\s\S]{0,180}actionLabel="去发现"[\s\S]{0,180}changeRootScreen\("discover"\)/,
    "an empty listening home must guide new users into discovery",
  );
  assert.equal(
    occurrences(podcastViewSource, /<DiscoveryShelf\b/g),
    1,
    "the full discovery shelf must have a single owner",
  );
  includes(
    discoverSurface,
    /title="中国区热门节目"[\s\S]{0,220}<DiscoveryShelf[\s\S]{0,180}shows=\{discoveryShows\}/,
    "discovery must own the complete regional catalog",
  );
  includes(
    podcastViewSource,
    /useEffect\(\(\)\s*=>\s*\{\s*if\s*\(screen\s*!==\s*"discover"\s*\|\|\s*discoveryState\s*!==\s*"idle"\)\s*return;\s*void loadDiscovery\(\);/,
    "regional discovery should load only when the user opens that surface",
  );

  const playEpisodeSource = declaredFunctionSource(podcastViewSource, "playEpisode");
  const downloadEpisodeSource = declaredFunctionSource(podcastViewSource, "downloadEpisode");
  includes(playEpisodeSource, /onPlayEpisode\(/, "episode play must hand off immediately to the shared player");
  excludes(
    playEpisodeSource,
    /podcast_download_episode/,
    "playing a podcast must not wait for a download command",
  );
  includes(
    downloadEpisodeSource,
    /podcastApi\.downloadPodcastEpisode|podcast_download_episode/,
    "offline download must remain an explicit secondary action",
  );

  includes(
    appSource,
    /convertFileSrc\(activePlayback\.episode\.episodeId,\s*"zone-podcast"\)/,
    "undownloaded episodes must use the bounded podcast stream protocol",
  );
  includes(
    appSource,
    /activePlayback\.episode\.playbackLocalPath[\s\S]{0,160}convertFileSrc\(\s*activePlayback\.episode\.playbackLocalPath,\s*"zone-audio"\s*\)/,
    "an episode whose playback source was selected as local must use the local audio protocol",
  );
  includes(
    podcastPlaybackSource,
    /playbackLocalPath:\s*episode\.localPath/,
    "the playback snapshot must select a downloaded file without mutating the episode record",
  );
});

test("continue listening cards reserve circular styling for the play action", () => {
  const continueCardSource =
    topLevelFunctionSource(podcastViewSource, "ContinueCard");

  includes(
    continueCardSource,
    /<button\b(?=[^>]*\bclassName="podcast-play-action")(?=[^>]*\bonClick=\{onPlay\})[^>]*>/,
    "ContinueCard play button must use the explicit podcast play-action class",
  );
  excludes(
    podcastCss,
    /\.podcast-continue-card\s*>\s*button\b/,
    "continue-card styles must not target every direct child button",
  );
  includes(
    podcastCss,
    /\.podcast-play-action\s*\{/,
    "the explicit podcast play action must own the circular control styling",
  );
});

test("listening home filters before truncation and surfaces new and played state on artwork", () => {
  for (const label of ["最近更新", "未收听", "下载优先"]) {
    includes(
      podcastViewSource,
      new RegExp(`label:\\s*"${label}"`),
      `missing listening filter: ${label}`,
    );
  }
  includes(
    podcastViewSource,
    /className="podcast-listen-filters"[\s\S]{0,120}aria-label="筛选来自你的节目"[\s\S]{0,320}aria-pressed=\{listenFilter\s*===\s*filter\.id\}/,
    "listening filters must expose an accessible mutually exclusive state",
  );
  includes(
    podcastViewSource,
    /listenFilter\s*===\s*"unplayed"[\s\S]{0,160}home\.unplayedEpisodes[\s\S]{0,160}listenFilter\s*===\s*"download-first"[\s\S]{0,160}home\.downloadPriorityEpisodes/,
    "bounded listening filters must select their database-filtered result sets",
  );
  includes(
    podcastViewSource,
    /filterPodcastListeningEpisodes\(\s*listeningFilterEpisodes,\s*listenFilter\s*\)/,
    "the selected database result set must still use the shared stable sorter",
  );
  includes(
    podcastViewSource,
    /filteredLatestEpisodes\.slice\(0,\s*8\)/,
    "the visible limit must be applied after filtering",
  );
  excludes(
    podcastViewSource,
    /latestEpisodes\.slice\(/,
    "the raw latest feed must not be truncated before filtering",
  );
  includes(
    podcastViewSource,
    /isPodcastEpisodeNew\(\s*episode,\s*feedById\.get\(episode\.feedId\)\?\.subscribedAt,\s*listenNewReferenceTime/,
    "new badges must combine discovery time with the feed subscription time",
  );
  includes(
    podcastViewSource,
    /listenFilter:\s*PodcastListenFilter/,
    "the active listening filter must survive the podcast session snapshot",
  );

  const episodeRowSource = topLevelFunctionSource(podcastViewSource, "EpisodeRow");
  includes(
    episodeRowSource,
    /showArtwork[\s\S]{0,900}podcast-episode-artwork[\s\S]{0,500}podcast-cover-progress/,
    "listening rows must place played state on their artwork",
  );
  includes(
    episodeRowSource,
    /podcast-new-badge[^>]*>\s*新\s*</,
    "new episodes must use a concise localized marker",
  );
  includes(
    episodeRowSource,
    /24 小时内更新/,
    "new state must be announced without relying on color alone",
  );
  includes(
    podcastCss,
    /\.podcast-listen-filters button\[aria-pressed="true"\][\s\S]{0,180}var\(--accent\)/,
    "the selected listening filter needs a restrained accent treatment",
  );
  includes(
    podcastCss,
    /\.podcast-episode\.with-artwork\s*\{[\s\S]{0,120}64px minmax\(0,\s*1fr\) 100px/,
    "artwork rows must preserve a bounded action column",
  );
});

test("podcast feeds refresh conditionally while cached content stays usable", () => {
  includes(
    typesSource,
    /export type PodcastRefreshReport\s*=[\s\S]{0,300}notModified:\s*number;[\s\S]{0,300}failures:/,
    "the frontend must share the conditional refresh report",
  );
  for (const field of [
    "subscribedAt",
    "lastCheckedAt",
    "lastRefreshError",
    "firstSeenAt",
    "webpageUrl",
  ]) {
    includes(typesSource, new RegExp(`\\b${field}\\b`), `missing podcast refresh field: ${field}`);
  }
  includes(
    podcastViewSource,
    /podcastApi\.refreshPodcastFeeds\(\{\s*force:\s*false\s*\}/,
    "the podcast surface must start a throttled background refresh after loading cache",
  );
  includes(
    declaredFunctionSource(podcastViewSource, "refreshSelectedFeed"),
    /podcastApi\.refreshPodcastFeeds\(\{\s*feedId:\s*selectedFeed\.id,\s*force:\s*true\s*\}/,
    "manual show refresh must bypass the interval for the selected feed",
  );
  excludes(
    declaredFunctionSource(podcastViewSource, "refreshSelectedFeed"),
    /podcast_preview_feed/,
    "manual refresh must use validators instead of re-running the preview path",
  );
  includes(
    podcastViewSource,
    /catch\s*\{\s*\/\/ Cached podcast content remains usable when a background refresh fails\./,
    "background refresh failures must preserve cached podcast content",
  );
  includes(
    declaredFunctionSource(podcastViewSource, "subscribeRss"),
    /setOpeningCandidate\(\{[\s\S]{0,220}title:\s*"RSS 订阅"/,
    "manual RSS subscribe must reuse the full-screen opening state",
  );
  includes(
    podcastViewSource,
    /const loadEpisodes\s*=\s*useCallback[\s\S]{0,220}episodeListRequestRef\.current\s*=\s*requestId[\s\S]{0,320}episodeListRequestRef\.current\s*!==\s*requestId\)\s*return null/,
    "late episode-list responses must not overwrite a newer selected feed",
  );
  includes(
    declaredFunctionSource(podcastViewSource, "refreshSelectedFeed"),
    /!listedFeed\s*&&\s*nextEpisodes\?\.\[0\][\s\S]{0,240}podcastApi\.getEpisodeDetail\([\s\S]{0,260}selectedFeedRef\.current\?\.id\s*===\s*selectedFeed\.id/,
    "manual refresh must reload metadata for an unsubscribed preview without racing navigation",
  );
  for (const column of [
    "subscribed_at",
    "last_checked_at",
    "last_refresh_error",
    "first_seen_at",
    "webpage_url",
  ]) {
    includes(podcastRustSource, new RegExp(`\\b${column}\\b`), `missing SQLite refresh column: ${column}`);
  }
  includes(
    podcastRustSource,
    /IF_NONE_MATCH|If-None-Match/,
    "conditional refresh must send the stored ETag",
  );
  includes(
    podcastRustSource,
    /StatusCode::NOT_MODIFIED/,
    "conditional refresh must handle HTTP 304 without parsing a body",
  );
});

test("episode detail exposes saved, played, queue, and offline lifecycle actions", () => {
  for (const command of [
    "podcast_get_episode_detail",
    "podcast_set_episode_saved",
    "podcast_list_saved_episodes",
    "podcast_set_episode_played",
    "podcast_delete_episode_download",
  ]) {
    assert.ok(hasInvoke(allFrontendSource, command), `episode experience does not invoke ${command}`);
  }

  includes(typesSource, /export type PodcastEpisodeDetail\s*=/, "the episode detail contract must be shared");
  includes(typesSource, /savedEpisodes:\s*PodcastEpisode\[\]/, "the podcast home must expose saved episodes");
  includes(podcastRustSource, /CREATE TABLE IF NOT EXISTS podcast_saved_episodes/, "saved episodes must persist in SQLite");
  includes(
    podcastViewSource,
    /podcastApi\.listSavedEpisodes\(\)[\s\S]{0,520}savedEpisodeDetails\.map\(\(detail\)\s*=>\s*detail\.episode\)/,
    "the saved-detail command must be normalized back to episode rows before rendering",
  );
  includes(
    podcastViewSource,
    /"podcast_list_saved_episodes"/,
    "saved episode listing must still go through the Rust command surface",
  );

  for (const label of ["稍后听", "标记为已播放", "删除下载"]) {
    includes(podcastViewSource, new RegExp(label), `episode detail is missing the ${label} action`);
  }
  includes(
    podcastViewSource,
    /podcast_get_episode_detail/,
    "opening an episode must resolve its complete detail rather than relying on a truncated list row",
  );
  includes(
    podcastRustSource,
    /completed\s*=\s*MAX\(podcast_progress\.completed,\s*excluded\.completed\)/,
    "ordinary progress saves must not undo an explicit played marker",
  );
  includes(
    podcastRustSource,
    /invalidate_download_if_enclosure_changed\([\s\S]{0,220}&episode\.enclosure_url/,
    "feed refresh must invalidate offline downloads when enclosure URLs rotate",
  );
  includes(
    podcastRustSource,
    /fn invalidate_download_if_enclosure_changed[\s\S]{0,1800}DELETE FROM podcast_downloads WHERE episode_id = \?1/,
    "enclosure rotation must clear managed download rows after removing final and part files",
  );
  includes(
    podcastRustSource,
    /fn prune_missing_feed_episodes/,
    "feed refresh must prune episodes that disappeared from the RSS",
  );
  includes(
    podcastRustSource,
    /prune_missing_feed_episodes\(&transaction,\s*&downloads_dir,\s*&feed\.id,\s*&episodes[^)]*\)/,
    "store_feed must run episode pruning after upserting the current feed items",
  );
  includes(
    podcastRustSource,
    /DELETE FROM podcast_episodes WHERE id = \?1 AND feed_id = \?2/,
    "gone-from-feed pruning must delete only unreferenced episode rows for that feed",
  );
  includes(
    podcastRustSource,
    /position_seconds = CASE[\s\S]{0,320}WHEN \?6 != 0 THEN excluded\.position_seconds/,
    "ordinary progress saves must only move the playhead forward unless force is set",
  );
  includes(
    podcastRustSource,
    /64:ff9b|0xff9b/,
    "IPv6 publicness checks must reject NAT64 translation prefixes",
  );

  const playEpisodeSource = declaredFunctionSource(podcastViewSource, "playEpisode");
  excludes(
    playEpisodeSource,
    /podcast_set_episode_saved|podcast_set_episode_played|podcast_download_episode/,
    "playing an episode must stay independent from save, played, and download actions",
  );
});

test("podcast queue is independent, durable, reorderable, and advances after an episode", () => {
  includes(typesSource, /export type PodcastQueueItem\s*=/, "the queue must have a podcast-specific item type");
  includes(
    podcastRustSource,
    /CREATE TABLE IF NOT EXISTS podcast_queue/,
    "the podcast queue must persist in SQLite instead of borrowing the music queue",
  );
  for (const command of [
    "podcast_list_queue",
    "podcast_queue_add",
    "podcast_queue_remove",
    "podcast_queue_remove_many",
    "podcast_queue_reorder",
    "podcast_queue_clear",
    "podcast_queue_autofill",
    "podcast_set_episodes_played",
  ]) {
    assert.ok(hasInvoke(appSource, command), `App does not wire durable queue command ${command}`);
  }

  includes(
    appSource,
    /useState<PodcastQueueItem\[\]>\(\[\]\)/,
    "App must keep a podcast queue separate from the music id queue",
  );
  includes(
    podcastPlaybackSource,
    /export function movePodcastQueueItem\(/,
    "queue reorder must use a podcast-specific operation",
  );
  includes(
    declaredFunctionSource(appSource, "queuePodcastEpisode"),
    /playNext/,
    "queue insertion must distinguish next-up from adding to the end",
  );
  includes(
    declaredFunctionSource(appSource, "movePodcastQueueEpisode"),
    /podcast_queue_reorder/,
    "reordering must be persisted after the optimistic move",
  );
  includes(
    declaredFunctionSource(appSource, "serializePodcastQueueMutation"),
    /podcastQueueMutationRef\.current\.then\(\s*operation,\s*operation\s*\)/,
    "queue mutations must be serialized so older responses cannot win",
  );
  for (const operation of [
    "queuePodcastEpisode",
    "removePodcastQueueEpisode",
    "clearPodcastQueue",
    "movePodcastQueueEpisode",
  ]) {
    includes(
      declaredFunctionSource(appSource, operation),
      /beginPodcastQueueMutation\(/,
      `${operation} must update the shared optimistic order before later mutations are computed`,
    );
  }
  includes(
    appSource,
    /podcastQueueRevisionRef\.current\s*===\s*revision/,
    "late queue snapshots must not overwrite newer optimistic operations",
  );
  const consumeSource = declaredFunctionSource(
    appSource,
    "consumePendingPodcastQueueEpisode",
  );
  includes(
    consumeSource,
    /shouldConsumePendingQueueEpisode\(\s*pendingPodcastQueueConsumeRef\.current,\s*activePodcastEpisodeRef\.current\?\.episodeId \?\? null,\s*audioEpisodeId,\s*episodeId,\s*\)/,
    "queue consumption must be gated by the shared pending/active/audio episode guard",
  );
  const playPodcastSource = declaredFunctionSource(appSource, "playPodcastEpisode");
  excludes(
    playPodcastSource,
    /podcast_queue_remove/,
    "selecting an episode must not consume it before playback starts",
  );
  includes(
    appSource,
    /\.play\(\)[\s\S]{0,520}consumePendingPodcastQueueEpisode\(\s*podcastEpisodeId,\s*podcastAudioEpisodeRef\.current\s*\)/,
    "a queued episode must be consumed only after its source successfully starts",
  );
  includes(
    appSource,
    /isCurrentPlayAttempt\(\s*\{\s*sourceKey, attempt: playAttempt\s*\}/,
    "late play promises from a replaced source must not consume or change the new episode",
  );
  includes(
    appSource,
    /isCurrentPlayAttempt\([\s\S]{0,160}audioPlayAttemptRef\.current,[\s\S]{0,80}activeAudioSourceKeyRef\.current,/,
    "late play promises from an older attempt on the same source must be ignored",
  );
  includes(
    appSource,
    /podcastQueue\.some\(\(item\)\s*=>\s*item\.episode\.id\s*===\s*episodeId\)[\s\S]{0,180}pendingPodcastQueueConsumeRef\.current\s*=\s*episodeId/,
    "a restored current episode must still consume a matching durable queue item after playback succeeds",
  );
  includes(
    appSource,
    /pendingPodcastQueueConsumeRef\.current\s*=\s*episodeId;[\s\S]{0,180}hasEpisodeStartedOnDevice\(episodeId\)[\s\S]{0,120}consumePendingPodcastQueueEpisode\(episodeId, episodeId\)/,
    "a queue snapshot restored after playback started must consume the already-playing episode",
  );
  includes(
    appSource,
    /podcastPlaybackStartedEpisodeRef\.current\s*=\s*podcastEpisodeId;[\s\S]{0,140}consumePendingPodcastQueueEpisode\(podcastEpisodeId, podcastAudioEpisodeRef\.current\)/,
    "successful playback must be remembered independently from the queue restore timing",
  );
  includes(
    consumeSource,
    /podcastQueueConsumeFailureRef\.current\s*=\s*\{\s*episodeId, revision\s*\}/,
    "a failed queue consume must be recorded so the restored queue snapshot cannot retrigger it in a loop",
  );
  includes(
    consumeSource,
    /podcastQueueConsumeFailureRef\.current\s*=\s*null;[\s\S]{0,120}applyPodcastQueueResult\(items, revision\)/,
    "a successful queue consume must clear the recorded failure",
  );
  includes(
    appSource,
    /!hasPodcastQueueConsumeFailure\(episodeId\)[\s\S]{0,120}pendingPodcastQueueConsumeRef\.current\s*=\s*episodeId/,
    "a failed queue consume must stay paused until the queue revision changes",
  );
  includes(
    declaredFunctionSource(appSource, "hasPodcastQueueConsumeFailure"),
    /failure\?\.episodeId === episodeId[\s\S]{0,80}failure\.revision === podcastQueueRevisionRef\.current/,
    "the consume failure marker must be scoped to the episode and the queue revision",
  );

  const endedSource = declaredFunctionSource(appSource, "handleEpisodeEnded");
  includes(endedSource, /playNextPodcastEpisode/, "episode completion must advance the podcast queue");
  assert.ok(
    endedSource.indexOf('kind === "episodeEnd"') < endedSource.indexOf("playNextPodcastEpisode"),
    "sleep-at-end must stop before queue advancement",
  );

  for (const affordance of [
    "onPlayQueueItem",
    "onRemoveQueueItem",
    "onMoveQueueItem",
    "onClearQueue",
  ]) {
    includes(
      podcastNowPlayingSource,
      new RegExp(`\\b${affordance}\\b`),
      `now playing is missing queue affordance ${affordance}`,
    );
  }
});

test("podcast now playing is a dedicated branch with podcast transport and recovery", () => {
  includes(
    appSource,
    /page\s*===\s*"nowPlaying"[\s\S]{0,320}activePodcastEpisode\s*\?[\s\S]{0,180}<PodcastNowPlayingView\b/,
    "now playing must select the podcast view when a podcast owns audio",
  );
  includes(
    appSource,
    /<PodcastNowPlayingView\b[\s\S]{0,2200}\)\s*:\s*\(\s*<NowPlayingView\b/,
    "the music NowPlayingView must remain the non-podcast branch",
  );
  includes(
    declaredFunctionSource(appSource, "openNowPlaying"),
    /!activePodcastEpisode\s*&&\s*!activeTrack/,
    "both music and podcasts must be able to open the shared full-screen destination",
  );
  includes(
    podcastPlayerBarSource,
    /onLabelClick=\{onOpenNowPlaying\}/,
    "the podcast player label must open its full-screen player",
  );
  includes(
    appSource,
    /<PodcastPlayerBar\b[\s\S]{0,700}status=\{podcastPlaybackStatus\}[\s\S]{0,260}onRetry=\{retryPodcastPlayback\}/,
    "the compact podcast player must receive playback errors and retry",
  );
  includes(
    podcastPlayerBarSource,
    /onClick=\{status\s*===\s*"error"\s*\?\s*onRetry\s*:\s*onPlayPause\}/,
    "the compact player play button must retry an errored stream",
  );

  excludes(
    nowPlayingSource,
    /\bPodcast(?:Episode|Feed|Playback|QueueItem|SleepTimer)?\b/,
    "the music NowPlayingView must stay podcast-free",
  );
  excludes(
    podcastNowPlayingSource,
    /\bTrack\b|NowPlayingMosaicCanvas|AudioGlowCanvas|LyricsStage/,
    "the podcast player must not reuse music models, mosaic, glow, or lyrics",
  );

  for (const control of [
    "后退 15 秒",
    "前进 30 秒",
    "onPlaybackRate",
    "onSleepTimer",
    "onRetry",
  ]) {
    includes(
      podcastNowPlayingSource,
      new RegExp(control),
      `podcast now playing is missing ${control}`,
    );
  }
});

test("episode detail preserves the full-screen now-playing return path and live progress", () => {
  includes(
    declaredFunctionSource(appSource, "openActivePodcastEpisode"),
    /returnToNowPlaying:\s*true/,
    "episode info opened from full-screen playback must carry its return origin",
  );
  includes(
    declaredFunctionSource(podcastViewSource, "closeEpisodeDetail"),
    /episodeReturnToNowPlaying[\s\S]{0,260}setPodcastSessionSnapshot\([\s\S]{0,220}onReturnToNowPlaying\(\)/,
    "closing episode info must restore the podcast session before returning to now playing",
  );
  includes(
    podcastViewSource,
    /const loadEpisodeDetail[\s\S]{0,900}episodeDetailRequestRef\.current\s*!==\s*requestId/,
    "a detail response that resolves during navigation exit must be ignored",
  );
  includes(
    podcastViewSource,
    /返回正在播放/,
    "episode detail must describe its full-screen return destination",
  );
  includes(
    appSource,
    /<PodcastView\b[\s\S]{0,500}activeProgress=\{progress\}[\s\S]{0,180}activeDuration=\{duration\}/,
    "PodcastView must receive the live media clock",
  );
  includes(
    podcastViewSource,
    /mergePodcastEpisodePlayback\(/,
    "podcast lists and detail must merge the live playback clock",
  );
  includes(
    podcastViewSource,
    /continueListening[\s\S]{0,180}\.filter\(\(episode\)\s*=>\s*!episode\.completed\)/,
    "a completed active episode must leave continue listening immediately",
  );
  includes(
    declaredFunctionSource(appSource, "handleEpisodeEnded"),
    /progressSaved\.finally\(\(\)\s*=>\s*\{[\s\S]{0,140}bumpLibraryRevision\(\)/,
    "episode completion must refresh cached podcast lists even when the queue advances",
  );
  includes(
    declaredFunctionSource(appSource, "bumpLibraryRevision"),
    /setPodcastLibraryRevision\(\(current\)\s*=>\s*current\s*\+\s*1\)/,
    "library revision bumps must remain a single domain command",
  );
  includes(
    podcastViewSource,
    /handledLibraryRevision\.current\s*=\s*libraryRevision;[\s\S]{0,160}loadHome\(\)/,
    "PodcastView must reload durable home state after playback completion",
  );
});

test("podcast playback handles speed, sleep, buffering, and errors on the shared audio", () => {
  includes(
    appSource,
    /PODCAST_PLAYBACK_RATES\s*=\s*\[[^\]]*0\.5[^\]]*3[^\]]*\]/,
    "podcast playback speed must cover the requested 0.5x to 3x range",
  );
  includes(
    appSource,
    /audio\.playbackRate\s*=\s*activePlayback\.kind\s*===\s*"podcast"\s*\?\s*podcastPlaybackRate\s*:\s*1/,
    "the shared audio rate must apply to podcasts and reset to 1x for music",
  );
  includes(
    appSource,
    /PODCAST_PLAYBACK_SETTINGS_KEY/,
    "the playback speed preference must survive navigation and restart",
  );
  includes(
    appSource,
    /let episodeId\s*=\s*readPodcastActiveEpisodeId\(\)/,
    "older WebView active episode settings remain a migration fallback",
  );
  includes(
    appSource,
    /podcast_load_active_episode[\s\S]{0,400}if\s*\(session\)\s*episodeId\s*=\s*session\.activeEpisodeId/,
    "the durable native current episode must take precedence during paused restore",
  );
  includes(
    appSource,
    /invoke<PodcastEpisodeDetail>\("podcast_get_episode_detail",\s*\{\s*episodeId\s*\}\)[\s\S]{0,1100}setActivePodcastEpisode\(podcastPlaybackForEpisode\(detail\.episode\)\)/,
    "the persisted active episode must be reconstructed from SQLite detail",
  );
  includes(
    appSource,
    /if\s*\(\s*!podcastSessionHydrated\s*\)\s*return null;/,
    "music playback must stay gated until the last podcast session is resolved",
  );
  includes(
    appSource,
    /podcastSessionRestoreCancelledRef\.current\s*\|\|\s*activePodcastEpisodeRef\.current/,
    "a failed stale restore must not clear a podcast selected during hydration",
  );
  includes(
    appSource,
    /activeEpisodeId:\s*activePodcastEpisode\?\.episodeId\s*\?\?\s*null/,
    "the current podcast session must be persisted separately from music state",
  );

  includes(
    appSource,
    /podcastSleepTimer\?\.kind\s*!==\s*"deadline"[\s\S]{0,420}setTimeout[\s\S]{0,260}flushPodcastProgress\(\)[\s\S]{0,120}pause\(\)/,
    "a deadline sleep timer must preserve progress before pausing",
  );
  includes(podcastNowPlayingSource, /SLEEP_MINUTES\s*=\s*\[15,\s*30,\s*45,\s*60\]/, "sleep choices are incomplete");
  includes(podcastNowPlayingSource, /kind:\s*"episodeEnd"/, "sleep-at-end is missing");

  for (const handler of [
    "onLoadStart={handleAudioLoadStart}",
    "onWaiting={handleAudioWaiting}",
    "onStalled={handleAudioWaiting}",
    "onCanPlay={handleAudioCanPlay}",
    "onError={handleAudioError}",
  ]) {
    includes(appSource, new RegExp(escapeRegExp(handler)), `shared audio is missing ${handler}`);
  }
  includes(typesSource, /"buffering"/, "podcast playback status must distinguish buffering");
  includes(typesSource, /"error"/, "podcast playback status must expose errors");
  includes(
    declaredFunctionSource(appSource, "retryPodcastPlayback"),
    /audio\.load\(\)[\s\S]{0,200}runPlayAttempt\(/,
    "retry must reload and play the same shared audio element",
  );
  includes(
    declaredFunctionSource(appSource, "retryPodcastPlayback"),
    /audioPlayAttemptRef\.current\s*=\s*playAttempt[\s\S]{0,520}runPlayAttempt\([\s\S]{0,200}playAttempt/,
    "retry must invalidate callbacks from an older attempt on the same episode",
  );
  includes(
    declaredFunctionSource(appSource, "runPlayAttempt"),
    /isCurrentPlayAttempt\(\s*\{\s*sourceKey, attempt: playAttempt\s*\},\s*audioPlayAttemptRef\.current,\s*activeAudioSourceKeyRef\.current,\s*\)/,
    "play attempts must ignore stale source or generation callbacks",
  );
  includes(
    declaredFunctionSource(appSource, "togglePlay"),
    /beginPlayAttempt\(\);[\s\S]{0,80}audio\.pause\(\)/,
    "pausing must invalidate a pending play promise before it can report an error",
  );
  includes(
    appSource,
    /podcastProgressMutationRef\.current\.then/,
    "progress writes must preserve seek order",
  );
  includes(
    declaredFunctionSource(appSource, "setPodcastEpisodePlayed"),
    /podcastProgressMutationRef\.current\.then\([\s\S]{0,220}podcast_set_episode_played/,
    "played and unplayed markers must be ordered with pending progress saves",
  );
  includes(
    declaredFunctionSource(appSource, "setPodcastEpisodePlayed"),
    /suppressPodcastProgressWrites\(episodeId\)[\s\S]{0,520}podcast_set_episode_played/,
    "marking the active episode must invalidate queued and automatic progress writes before the mutation",
  );
  includes(
    declaredFunctionSource(appSource, "setPodcastEpisodePlayed"),
    /resumePodcastProgressWritesIfActivelyPlaying\(episodeId\)/,
    "a settled mark while the episode keeps playing must reopen progress writes under a fresh epoch",
  );
  includes(
    declaredFunctionSource(appSource, "resumePodcastProgressWritesIfActivelyPlaying"),
    /!audioRef\.current\.paused[\s\S]{0,400}if \(stillPlaying\) resumePodcastProgressWrites/,
    "paused mark-unplayed must keep progress suppressed so a later flush cannot resurrect it",
  );
  const persistProgressSource = declaredFunctionSource(
    appSource,
    "persistPodcastProgress",
  );
  includes(
    persistProgressSource,
    /podcastProgressWriteGateRef\.current\.isSuppressed\(episode\.episodeId\)[\s\S]{0,180}return podcastProgressMutationRef\.current/,
    "automatic progress must stay suspended after an explicit played-state mutation",
  );
  includes(
    persistProgressSource,
    /podcastProgressWriteGateRef\.current\.capture\([\s\S]{0,900}podcastProgressWriteGateRef\.current\.allows\(/,
    "queued progress saves must be discarded when a newer explicit mutation invalidates their epoch",
  );
  includes(
    persistProgressSource,
    /"podcast_save_progress"[\s\S]{0,180}force,/,
    "progress persistence must pass force so seeks can rewind while ordinary writes stay monotonic",
  );
  includes(
    declaredFunctionSource(appSource, "togglePlay"),
    /audio\.paused[\s\S]{0,180}resumePodcastProgressWrites/,
    "a later explicit resume must start a new progress-writing session",
  );
  includes(
    appSource,
    /resolvePodcastStartPosition\([\s\S]*?activePlayback\.episode\.savedProgressSeconds,?\s*\)[\s\S]*?setProgress\(Math\.max\(0,\s*startPosition\)\)/,
    "a restored episode or explicit chapter start must show its pending position before media metadata is available",
  );
  const flushProgressSource = declaredFunctionSource(appSource, "flushPodcastProgress");
  includes(
    flushProgressSource,
    /resumePending\s*\?\s*pending!\.position\s*:\s*audio\.currentTime/,
    "flushing during media hydration must preserve the pending saved position",
  );
  includes(
    flushProgressSource,
    /episode\?\.durationSeconds\s*\?\?\s*0/,
    "flushing before metadata must preserve the episode duration fallback",
  );
  includes(
    declaredFunctionSource(appSource, "handleTimeUpdate"),
    /pending\?\.episodeId\s*===\s*podcastEpisode\.episodeId[\s\S]{0,140}setProgress\(\s*Math\.max\(0,\s*pending\.position\)\s*\)[\s\S]{0,80}return;/,
    "zero-valued media events must not replace a pending restored position",
  );
  includes(
    declaredFunctionSource(appSource, "seek"),
    /pendingPodcastResumeRef\.current\s*=\s*null[\s\S]{0,120}currentTime\s*=\s*value/,
    "an explicit seek must supersede the pending restored position",
  );
  includes(
    appSource,
    /useEffect\(\(\)\s*=>\s*\(\)\s*=>\s*\{[\s\S]{0,360}flushPodcastProgress\(\);[\s\S]{0,40}\},\s*\[\]\);/,
    "application shutdown must use the same resume-safe progress flush path",
  );
});

test("podcast detail, menus, and full-screen layout cover keyboard and minimum-window basics", () => {
  includes(
    baseCss,
    /\.shell\s*\{(?=[^}]*min-width:\s*920px)[^}]*\}/,
    "the app shell must honor Tauri's 920px minimum width",
  );
  excludes(baseCss, /min-width:\s*1024px/, "the old 1024px clipping floor must be removed");
  includes(
    podcastCss,
    /@media\s*\(max-width:\s*960px\)\s*\{[\s\S]*?\.podcast-continue-grid\s*\{\s*grid-template-columns:\s*1fr;/,
    "podcast layout must adapt before reaching the supported 920px minimum width",
  );
  excludes(
    podcastCss,
    /@media\s*\(max-width:\s*880px\)/,
    "podcast minimum-window rules must not sit below the app's reachable width",
  );
  for (const selector of [".podcast-play-action", ".podcast-download-action"]) {
    includes(
      podcastCss,
      new RegExp(
        `${selector.replace(".", "\\.")}\\s*\\{(?=[^}]*width:\\s*44px)(?=[^}]*height:\\s*44px)[^}]*\\}`,
      ),
      `${selector} must retain a full-size pointer target`,
    );
  }
  includes(
    podcastCss,
    /\.podcast-episode-copy p\s*\{(?=[^}]*font-size:\s*12px)(?=[^}]*color:\s*rgba\(247,\s*242,\s*246,\s*0\.54\))[^}]*\}/,
    "episode summaries must remain readable against the dark surface",
  );
  includes(
    podcastCss,
    /\.podcast-detail-meta\s*\{(?=[^}]*font-size:\s*11px)(?=[^}]*color:\s*rgba\(247,\s*242,\s*246,\s*0\.52\))[^}]*\}/,
    "episode detail metadata must not fall back to micro-copy contrast",
  );
  includes(
    podcastCss,
    /\.podcast-current-episode\s*\{(?=[^}]*grid-template-columns:\s*70px\s+minmax\(0,\s*1fr\)\s+44px)[^}]*\}/,
    "the current episode row must reserve the full play-control width",
  );
  includes(
    podcastCss,
    /\.podcast-inline-state\s*\{(?=[^}]*font-size:\s*11px)(?=[^}]*color:\s*rgba\(247,\s*242,\s*246,\s*0\.52\))[^}]*\}/,
    "podcast loading and empty states must remain legible",
  );
  includes(
    podcastCss,
    /\.podcast-search-form input,\s*\.podcast-rss-entry input\s*\{(?=[^}]*height:\s*44px)[^}]*\}[\s\S]{0,300}\.podcast-search-form button,\s*\.podcast-rss-entry form button\s*\{(?=[^}]*height:\s*44px)[^}]*\}/,
    "podcast search and RSS controls must share a comfortable input height",
  );
  includes(
    podcastViewSource,
    /window\.addEventListener\("keydown",\s*handleEscape\)/,
    "show and episode screens must support Escape navigation",
  );
  includes(
    podcastViewSource,
    /headingRef\.current\?\.focus\(\{\s*preventScroll:\s*true\s*\}\)/,
    "internal podcast navigation must move focus to the new heading",
  );
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape"]) {
    includes(
      podcastNowPlayingSource,
      new RegExp(`event\\.key\\s*===\\s*"${key}"`),
      `podcast playback menu is missing ${key} keyboard behavior`,
    );
  }
  assert.equal(
    occurrences(podcastNowPlayingSource, /aria-haspopup="menu"/g),
    2,
    "speed and sleep triggers must expose menu semantics",
  );
  includes(
    podcastNowPlayingSource,
    /\(selected\s*\?\?\s*items\[0\]\)\?\.focus\(\)/,
    "opening a playback menu must focus its selected or first item",
  );
  includes(
    podcastNowPlayingCss,
    /@media\s*\(max-height:\s*680px\)\s*\{[\s\S]*?\.podcast-now-copy\s*\{(?=[^}]*max-height:\s*100%)(?=[^}]*overflow-y:\s*auto)[^}]*\}/,
    "short windows must keep long episode copy inside the transport boundary",
  );
});

test("podcast now-playing queue defaults closed and behaves as an accessible side panel", () => {
  includes(
    podcastNowPlayingSource,
    /const\s*\[queueOpen,\s*setQueueOpen\]\s*=\s*useState\(false\)/,
    "the full-screen queue must default to closed",
  );
  includes(
    podcastNowPlayingSource,
    /className="podcast-now-queue-trigger"[\s\S]{0,180}aria-controls="podcast-now-queue"[\s\S]{0,120}aria-expanded=\{queueOpen\}/,
    "the queue trigger must expose its controlled expanded state",
  );
  includes(
    podcastNowPlayingSource,
    /const queuePanelElement\s*=\s*queueOpen\s*\?\s*\([\s\S]{0,160}<aside[\s\S]{0,120}id="podcast-now-queue"/,
    "the queue panel must not exist in the default closed state",
  );
  includes(
    podcastNowPlayingSource,
    /<Presence\s+show=\{queuePanelElement\s*!==\s*null\}\s+exitDurationMs=\{MOTION_DURATIONS\.micro\}>/,
    "the queue panel must keep a paired exit lifecycle",
  );

  const escapeSource = declaredFunctionSource(
    podcastNowPlayingSource,
    "handleEscape",
  );
  assert.ok(
    escapeSource.indexOf("if (activeMenu)") < escapeSource.indexOf("if (queueOpen)")
      && escapeSource.indexOf("if (queueOpen)") < escapeSource.indexOf("onBack()"),
    "Escape must close a menu, then the queue, before leaving now playing",
  );
  includes(
    podcastNowPlayingSource,
    /queueCloseRef\.current\?\.focus\(\)/,
    "opening the queue must focus its close control",
  );
  includes(
    declaredFunctionSource(podcastNowPlayingSource, "closeQueue"),
    /queueTriggerRef\.current\?\.focus\(\)/,
    "closing the queue from within must restore focus to its trigger",
  );

  includes(
    podcastNowPlayingCss,
    /\.podcast-now-queue\s*\{(?=[^}]*position:\s*absolute)(?=[^}]*right:\s*clamp\()(?=[^}]*transform:\s*translate3d\(0,\s*0,\s*0\))[^}]*\}/,
    "the queue must open as a right-anchored non-modal panel without reflowing playback",
  );
  includes(
    podcastNowPlayingCss,
    /@starting-style\s*\{\s*\.podcast-now-queue\s*\{(?=[^}]*opacity:\s*0)(?=[^}]*translate3d\(18px,\s*0,\s*0\))[^}]*\}/,
    "the queue panel must enter from its owning edge",
  );
  includes(
    podcastNowPlayingCss,
    /\.motion-exit\s+\.podcast-now-queue\s*\{(?=[^}]*opacity:\s*0)(?=[^}]*translate3d\(12px,\s*0,\s*0\))[^}]*\}/,
    "the queue panel must exit back toward the same edge",
  );
  includes(
    motionCss,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.podcast-now-queue[\s\S]*?transform:\s*none\s*!important;/,
    "reduced motion must remove queue-panel travel",
  );
});

test("system media uses cached podcast artwork and later-listen as favorite", () => {
  includes(
    appSource,
    /invoke<string \| null>\("podcast_cache_artwork",\s*\{\s*url:\s*artworkUrl\s*\}/,
    "playing podcasts must cache artwork to a local path for the taskbar",
  );
  includes(
    appSource,
    /coverPath:\s*podcastArtworkCoverPath/,
    "system media must use the cached podcast artwork path",
  );
  includes(
    appSource,
    /isFavorite:\s*activePodcastEpisode \? Boolean\(activePodcastEpisode\.saved\)/,
    "the taskbar heart must reflect later-listen for podcasts",
  );
  includes(
    appSource,
    /if \(activePodcastEpisode\) void toggleActivePodcastSaved\(\)/,
    "the taskbar heart must toggle later-listen for podcasts",
  );
  excludes(
    appSource,
    /activePodcastEpisode \? false : isActiveTrackFavorite/,
    "podcasts must not hard-disable the taskbar favorite button",
  );
});

test("remote podcast artwork is isolated behind the bounded Rust proxy", () => {
  includes(
    podcastArtworkSource,
    /convertFileSrc\(\s*token,\s*"zone-podcast-artwork"\s*\)/,
    "podcast artwork must use the dedicated safe protocol",
  );
  includes(
    rustEntrySource,
    /register_asynchronous_uri_scheme_protocol\(\s*"zone-podcast-artwork"/,
    "Tauri must register the podcast artwork protocol",
  );
  includes(
    podcastViewSource,
    /podcastArtworkSrc\(\s*url\s*\)/,
    "show and episode artwork must be proxied",
  );
  includes(
    podcastPlayerBarSource,
    /podcastArtworkSrc\(\s*episode\.artworkUrl\s*\)/,
    "the podcast player artwork must be proxied",
  );
  includes(
    podcastNowPlayingSource,
    /podcastArtworkSrc\(\s*artworkUrl\s*\)/,
    "the full-screen podcast artwork must be proxied",
  );
  includes(
    rustEntrySource,
    /podcast::podcast_cache_artwork/,
    "Tauri must register the podcast artwork disk-cache command",
  );
  excludes(
    `${podcastViewSource}\n${podcastPlayerBarSource}\n${podcastNowPlayingSource}`,
    /<img[^>]+src=\{(?:url|episode\.artworkUrl)\}/,
    "remote RSS artwork must never be loaded directly by the WebView",
  );
});

test("podcast episodes remain outside the music queue, Track, and beat analysis", () => {
  const trackType = declaredTypeBody(typesSource, "Track");
  const playPodcastSource = declaredFunctionSource(appSource, "playPodcastEpisode");
  const moveSource = declaredFunctionSource(appSource, "move");

  excludes(trackType, /podcast|feedUrl|enclosureUrl|downloadState/i, "Track must stay music-only");
  excludes(
    podcastViewSource,
    /\bTrack\b|\b(?:setQueue|appendToQueue|onAddToQueue|queueIds)\b/,
    "PodcastView may use its podcast queue but must not import the music queue model",
  );
  excludes(
    podcastPlayerBarSource,
    /\bTrack\b|\b(?:setQueue|appendToQueue|onAddToQueue|queueIds)\b/,
    "the podcast bar must not use Track or the music queue",
  );
  excludes(
    playPodcastSource,
    /\b(?:setQueue|setActiveTrackId|appendToQueue|preAnalyzeBeatGrid)\b/,
    "starting a podcast must not mutate the music queue or active track",
  );
  includes(
    playPodcastSource,
    /setActivePodcastEpisode\(latestProgress[\s\S]*?savedProgressSeconds:\s*latestProgress\.progressSeconds/,
    "podcast playback must use its separate active state",
  );
  includes(
    moveSource,
    /if\s*\(\s*activePodcastEpisode\s*\)\s*return\b/,
    "music queue movement must stop while a podcast owns playback",
  );
  includes(
    appSource,
    /if\s*\(\s*activePlayback\.kind\s*===\s*"music"\s*\)[\s\S]{0,400}preAnalyzeBeatGrid\(\s*activePlayback\.track\s*\)/,
    "beat pre-analysis must stay behind the music playback branch",
  );
  excludes(
    appSource,
    /preAnalyzeBeatGrid\(\s*(?:(?:activePodcastEpisode|podcast|episode)\b|activePlayback(?!\.track))/i,
    "podcasts must not enter music beat pre-analysis",
  );

  includes(appSource, /activePodcastEpisode/, "App must keep separate podcast playback state");
  includes(appSource, /<PodcastPlayerBar\b/, "App must render the podcast-specific player bar");
  excludes(
    playerBarSource,
    /\bPodcast(?:Episode|Feed|Probe|Playback)?\b/,
    "the music PlayerBar must remain podcast-free",
  );
});

function sourceFiles(root, extensionPattern) {
  const entries = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      entries.push(...sourceFiles(absolutePath, extensionPattern));
    } else if (extensionPattern.test(entry.name)) {
      entries.push({
        path: relative(".", absolutePath).replaceAll("\\", "/"),
        source: readFileSync(absolutePath, "utf8"),
      });
    }
  }

  return entries;
}

function occurrences(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

function includes(source, pattern, message) {
  assert.ok(pattern.test(source), message);
}

function excludes(source, pattern, message) {
  assert.ok(!pattern.test(source), message);
}

function hasInvoke(source, command) {
  const commandPattern = new RegExp(
    String.raw`\binvoke(?:<[^>\n]+>)?\s*\(\s*["']${command}["']`,
  );
  const scopedPattern = new RegExp(String.raw`\binvokeNetwork(?:<[^>\n]+>)?\s*\(\s*(?:["'][^"']*["']|\`[^\`]*\`)\s*,\s*["']${command}["']`);
  return commandPattern.test(source) || (scopedPattern.test(source)
    && /return invoke<T>\(command, \{ \.\.\.args, requestId \}\)/.test(source));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function declaredTypeBody(source, name) {
  const declaration = new RegExp(
    String.raw`export\s+(?:interface|type)\s+${name}\b[^={]*[={]([\s\S]*?)\n}`,
  ).exec(source);
  assert.ok(declaration, `missing ${name} declaration`);
  return declaration[1];
}

function declaredFunctionSource(source, name) {
  const declaration = new RegExp(
    String.raw`\bfunction\s+${name}(?:<[^>]+>)?\s*\(`,
  ).exec(source);
  assert.ok(declaration, `missing ${name} function`);
  const tail = source.slice(declaration.index + declaration[0].length);
  const nextDeclaration = /\n {2}(?:async\s+)?function\s+\w/.exec(tail);
  return source.slice(
    declaration.index,
    nextDeclaration
      ? declaration.index + declaration[0].length + nextDeclaration.index
      : source.length,
  );
}

function topLevelFunctionSource(source, name) {
  const declaration = new RegExp(
    String.raw`^function\s+${name}\s*\(`,
    "m",
  ).exec(source);
  assert.ok(declaration, `missing ${name} declaration`);

  const bodyStart = declaration.index + declaration[0].length;
  const tail = source.slice(bodyStart);
  const nextDeclaration = /^function\s+\w+\s*\(/m.exec(tail);

  return source.slice(
    declaration.index,
    nextDeclaration ? bodyStart + nextDeclaration.index : source.length,
  );
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
