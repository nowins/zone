/**
 * Build usePodcastViewModel.ts from PodcastView.tsx (logic only).
 */
import { readFileSync, writeFileSync } from "node:fs";

const original = readFileSync("src/views/PodcastView.tsx", "utf8");
const returnMarker =
  "\n  return (\n    <section className=\"content-band podcast-page\">";
const returnIdx = original.indexOf(returnMarker);
if (returnIdx < 0) {
  console.error("JSX return marker not found");
  process.exit(1);
}

writeFileSync(
  "src/views/podcast/_jsx_extract.txt",
  original.slice(returnIdx),
  "utf8",
);

let s = original.slice(0, returnIdx);

// Drop invoke + icons
s = s.replace('import { invoke } from "@tauri-apps/api/core";\n', "");
s = s.replace(
  /import \{\n  ArrowLeft,\n  ArrowRight,\n  Check,\n  LoaderCircle,\n  RefreshCw,\n  Rss,\n  Search,\n\} from "lucide-react";\n/,
  "",
);

s = s.replace(
  /import \{\n  PodcastEpisodeContextMenu,\n  type PodcastEpisodeMenuState,\n\} from "\.\.\/components\/PodcastEpisodeContextMenu";\n/,
  'import type { PodcastEpisodeMenuState } from "../../components/PodcastEpisodeContextMenu";\n',
);

s = s.replace(
  /import \{ Presence, useLastNonNull \} from "\.\.\/motion\/presence";\nimport \{ MOTION_DURATIONS \} from "\.\.\/motion\/tokens";\n/,
  'import { useLastNonNull } from "../../motion/presence";\n',
);

s = s.replaceAll('from "../utils/', 'from "../../utils/');
s = s.replaceAll('from "../types"', 'from "../../types"');
s = s.replaceAll('from "./podcast/', 'from "./');

// Remove only the targeted component import blocks (do not span other imports).
for (const mod of [
  "primitives",
  "EpisodeRows",
  "QueueEpisodeRow",
  "EpisodeDetail",
  "ContinueCard",
  "ShowCards",
  "Dialogs",
]) {
  s = s.replace(
    new RegExp(
      `import\\s*\\{[^{}]*\\}\\s*from\\s*"\\.\\/components\\/${mod}";\\n`,
    ),
    "",
  );
}

s = s.replace(
  '} from "react";\n',
  `} from "react";
import * as podcastApi from "./api";
`,
);

s = s.replace(
  "export function PodcastView({",
  "export function usePodcastViewModel({",
);

/**
 * Replace every invoke("cmd", args?) / invoke<T>("cmd", args?) with an api call.
 * Uses regex find + balanced-paren scan so multi-line args are safe.
 */
function replaceInvokes(source) {
  const re = /\b(await\s+)?invoke(?:<[^<>]+>)?\(/g;
  let out = "";
  let last = 0;
  let match;
  while ((match = re.exec(source)) !== null) {
    const start = match.index;
    const openAt = re.lastIndex - 1; // '('
    let depth = 0;
    let j = openAt;
    for (; j < source.length; j++) {
      const ch = source[j];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }
    const call = source.slice(start, j);
    out += source.slice(last, start);
    const withAwait = Boolean(match[1]);
    const inner = call
      .replace(/^await\s+/, "")
      .replace(/^invoke(?:<[^<>]+>)?\(/, "")
      .replace(/\)$/, "");
    const cmdMatch = inner.match(/^\s*"([^"]+)"\s*(?:,\s*([\s\S]*))?\s*$/);
    if (!cmdMatch) {
      console.warn("unparsed invoke:", call.slice(0, 100));
      out += call;
      last = j;
      re.lastIndex = j;
      continue;
    }
    const cmd = cmdMatch[1];
    const args = (cmdMatch[2] || "").trim();
    const replacement = mapInvoke(cmd, args, withAwait);
    if (!replacement) {
      console.warn("unmapped command", cmd, args.slice(0, 60));
      out += call;
      last = j;
      re.lastIndex = j;
      continue;
    }
    out += replacement;
    last = j;
    re.lastIndex = j;
  }
  out += source.slice(last);
  return out;
}

function mapInvoke(cmd, args, withAwait) {
  const a = withAwait ? "await " : "";
  switch (cmd) {
    case "podcast_list_feeds":
      return `${a}podcastApi.listPodcastFeeds()`;
    case "podcast_list_home":
      return `${a}podcastApi.listPodcastHome()`;
    case "podcast_list_saved_episodes":
      return `${a}podcastApi.listSavedEpisodes()`;
    case "podcast_list_downloads":
      return `${a}podcastApi.listPodcastDownloads(offset, PODCAST_DOWNLOAD_PAGE_SIZE)`;
    case "podcast_browse_apple":
      return `${a}podcastApi.browseApplePodcasts(24)`;
    case "podcast_list_episodes":
      return `${a}podcastApi.listPodcastEpisodes(feed.id)`;
    case "podcast_refresh_feeds":
      if (args.includes("force: false")) {
        return `${a}podcastApi.refreshPodcastFeeds({ force: false })`;
      }
      if (args.includes("force: true")) {
        return `${a}podcastApi.refreshPodcastFeeds({ feedId: selectedFeed.id, force: true })`;
      }
      return `${a}podcastApi.refreshPodcastFeeds(${args})`;
    case "podcast_list_related_episodes":
      return `${a}podcastApi.listRelatedEpisodes(episodeId, 6)`;
    case "podcast_get_episode_chapters":
      return `${a}podcastApi.getEpisodeChapters(episodeId)`;
    case "podcast_get_episode_detail": {
      if (args.includes("nextEpisodes[0]")) {
        return `${a}podcastApi.getEpisodeDetail(nextEpisodes[0].id)`;
      }
      if (args.includes("episode.id")) {
        return `${a}podcastApi.getEpisodeDetail(episode.id)`;
      }
      if (args.includes("episodeId")) {
        return `${a}podcastApi.getEpisodeDetail(episodeId)`;
      }
      return null;
    }
    case "podcast_delete_episode_downloads":
      return `${a}podcastApi.deleteEpisodeDownloads(intent.episodeIds)`;
    case "podcast_clear_completed_downloads":
      return `${a}podcastApi.clearCompletedDownloads()`;
    case "podcast_search_apple":
      return `${a}podcastApi.searchApplePodcasts(cleanQuery, 18)`;
    case "podcast_preview_feed":
      return `${a}podcastApi.previewPodcastFeed(candidate.feedUrl)`;
    case "podcast_subscribe":
      return `${a}podcastApi.subscribePodcastFeed(cleanUrl)`;
    case "podcast_set_following":
      return `${a}podcastApi.setFeedFollowing(selectedFeed.id, nextSubscribed)`;
    case "podcast_download_episode":
      return `${a}podcastApi.downloadPodcastEpisode(episode.id)`;
    case "podcast_delete_episode_download":
      return `${a}podcastApi.deleteEpisodeDownload(detail.episode.id)`;
    case "podcast_set_episode_saved":
      return `${a}podcastApi.setEpisodeSaved(detail.episode.id, nextSaved)`;
    default:
      return null;
  }
}

s = replaceInvokes(s);

if (/invoke[<(]/.test(s)) {
  console.error("Remaining invoke:");
  for (const line of s.split("\n")) {
    if (/invoke[<(]/.test(line)) console.error(line.trim());
  }
  process.exit(1);
}

const returnBag = `
  return {
    screen,
    returnScreen,
    heading,
    eyebrow,
    headingRef,
    changeRootScreen,
    closeShow,
    closeEpisodeDetail,
    openEpisodeShow,
    toggleFollowing,
    following,
    selectedFeed,
    episodeReturnToNowPlaying,
    episodeOriginScreen,
    selectedEpisodeDetail,
    notice,
    error,
    setError,
    continueListeningEpisodes,
    latestEpisodes,
    filteredLatestEpisodes,
    listenFilter,
    setListenFilter,
    listenNewReferenceTime,
    hasListenContent,
    homeState,
    loadHome,
    query,
    setQuery,
    searchApple,
    searchState,
    discoveryTopic,
    rssExpanded,
    setRssExpanded,
    rssUrl,
    setRssUrl,
    subscribeRss,
    openingId,
    searchHistory,
    setSearchHistory,
    repeatPodcastSearch,
    browseDiscoveryTopic,
    searchHeading,
    searchResults,
    showPopularDiscovery,
    searchSort,
    setSearchSort,
    sortedSearchResults,
    feeds,
    searchHighlightQuery,
    previewFeed,
    discoveryState,
    discoveryShows,
    loadDiscovery,
    libraryState,
    librarySort,
    setLibrarySort,
    orderedFeeds,
    openStoredFeed,
    moveFollowedFeed,
    savedEpisodes,
    downloadedEpisodes,
    recentlyPlayedEpisodes,
    recentHistoryExpanded,
    setRecentHistoryExpanded,
    downloadLibraryState,
    downloadGroups,
    downloadedBytes,
    downloadedCount,
    downloadedFeedCount,
    hasDownloadedLibraryPage,
    downloadPage,
    loadDownloadedLibrary,
    loadingMoreDownloads,
    downloadSelectionMode,
    toggleDownloadSelectionMode,
    toggleAllLoadedDownloads,
    allLoadedDownloadsSelected,
    loadedDownloadsExceedBatchLimit,
    selectedDownloadIds,
    toggleDownloadSelection,
    requestSelectedDownloadDeletion,
    setDownloadCleanupIntent,
    downloadCleanupIntent,
    lastDownloadCleanupIntent,
    downloadCleanupAction,
    confirmDownloadCleanup,
    knownActiveEpisode,
    currentEpisodeId,
    isPlaying,
    playEpisode,
    openEpisodeDetail,
    showEpisodeMenu,
    upNextQueue,
    queueSelectionMode,
    toggleQueueSelectionMode,
    toggleAllQueueEpisodes,
    allQueueEpisodesSelected,
    selectedQueueIds,
    selectedQueueEpisodes,
    toggleQueueSelection,
    downloadSelectedQueueEpisodes,
    setSelectedQueueEpisodesPlayed,
    requestSelectedQueueRemoval,
    queueBatchAction,
    queueAnnouncement,
    autoQueueMode,
    onAutoQueueMode,
    onClearQueue,
    draggedQueueEpisodeId,
    queueDropTarget,
    handleQueueDragStart,
    handleQueueDragOver,
    handleQueueDrop,
    resetQueueDrag,
    onMoveQueueEpisode,
    onRemoveQueueEpisode,
    onReorderQueueEpisode,
    queueRemovalIntent,
    lastQueueRemovalIntent,
    setQueueRemovalIntent,
    confirmQueueRemoval,
    displayedEpisodes,
    episodeState,
    loadEpisodes,
    refreshSelectedFeed,
    displayedEpisodeDetail,
    detailState,
    liveActiveEpisode,
    activeProgress,
    activeDuration,
    detailQueuePosition,
    detailAction,
    downloadingId,
    updatingPlayedId,
    chapterDocument,
    chapterState,
    chaptersOpen,
    toggleEpisodeChapters,
    loadEpisodeChapters,
    playEpisodeAt,
    onQueueEpisode,
    toggleEpisodeSaved,
    toggleEpisodePlayed,
    downloadEpisode,
    deleteEpisodeDownload,
    shareEpisode,
    displayedRelatedEpisodes,
    relatedState,
    episodeMenu,
    setEpisodeMenu,
    queueEpisodeFromMenu,
    toggleEpisodePlayedFromMenu,
    feedById,
  };
}
`;

s = s.trimEnd() + "\n" + returnBag + "\n";
writeFileSync("src/views/podcast/usePodcastViewModel.ts", s, "utf8");
console.log("OK lines", s.split("\n").length);
console.log("api calls", (s.match(/podcastApi\./g) || []).length);
