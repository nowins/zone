import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const sourcePath = join(root, "src/views/podcast/usePodcastViewModel.ts");
let src = readFileSync(sourcePath, "utf8");

const returnMarker = "\n  return (\n    <section className=\"content-band podcast-page\">";
const returnIdx = src.indexOf(returnMarker);
if (returnIdx < 0) {
  console.error("Main JSX return marker not found");
  process.exit(1);
}

const logic = src.slice(0, returnIdx);
const jsxBlock = src.slice(returnIdx); // includes `  return (` through end of function

// Capture JSX body for screens (strip outer return/section wrappers later in PodcastView)
writeFileSync(join(root, "src/views/podcast/_jsx_extract.txt"), jsxBlock, "utf8");

// Transform logic into usePodcastViewModel
let next = logic;

next = next.replace(
  'import { invoke } from "@tauri-apps/api/core";\n',
  "",
);

next = next.replace(
  `import {
  ArrowLeft,
  ArrowRight,
  Check,
  LoaderCircle,
  RefreshCw,
  Rss,
  Search,
} from "lucide-react";
`,
  "",
);

// Keep types/helpers imports; drop view-only component imports that only appear in JSX.
// Context menu + dialogs + episode UI only used in JSX — remove from model.
next = next.replace(
  `import {
  PodcastEpisodeContextMenu,
  type PodcastEpisodeMenuState,
} from "../components/PodcastEpisodeContextMenu";
`,
  `import type { PodcastEpisodeMenuState } from "../components/PodcastEpisodeContextMenu";
`,
);

next = next.replace(
  `import { Presence, useLastNonNull } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";
`,
  `import { useLastNonNull } from "../../motion/presence";
`,
);

// Fix relative imports: file is now under views/podcast/
next = next.replaceAll('from "../components/', 'from "../../components/');
next = next.replaceAll('from "../motion/', 'from "../../motion/');
next = next.replaceAll('from "../utils/', 'from "../../utils/');
next = next.replaceAll('from "../types"', 'from "../../types"');
// Local podcast imports were ./podcast/ — now same directory
next = next.replaceAll('from "./podcast/', 'from "./');

// Add api import after react imports
if (!next.includes('from "./api"')) {
  next = next.replace(
    'from "react";\n',
    `from "react";
import * as podcastApi from "./api";
`,
  );
}

// Replace invoke calls with podcastApi helpers
const replacements = [
  [
    /await invoke<PodcastFeed\[\]>\("podcast_list_feeds"\)/g,
    "await podcastApi.listPodcastFeeds()",
  ],
  [
    /invoke<PodcastHome>\("podcast_list_home"\)/g,
    "podcastApi.listPodcastHome()",
  ],
  [
    /invoke<PodcastEpisodeDetail\[\]>\("podcast_list_saved_episodes"\)/g,
    "podcastApi.listSavedEpisodes()",
  ],
  [
    /await invoke<PodcastDownloadPage>\(\s*"podcast_list_downloads",\s*\{\s*offset,\s*limit: PODCAST_DOWNLOAD_PAGE_SIZE,\s*\}\s*\)/g,
    "await podcastApi.listPodcastDownloads(offset, PODCAST_DOWNLOAD_PAGE_SIZE)",
  ],
  [
    /await invoke<PodcastDiscoveryShow\[\]>\(\s*"podcast_browse_apple",\s*\{\s*limit: 24,\s*\}\s*\)/g,
    "await podcastApi.browseApplePodcasts(24)",
  ],
  [
    /await invoke<PodcastEpisode\[\]>\(\s*"podcast_list_episodes",\s*\{\s*feedId: feed\.id,\s*\}\s*\)/g,
    "await podcastApi.listPodcastEpisodes(feed.id)",
  ],
  [
    /await invoke<PodcastRefreshReport>\(\s*"podcast_refresh_feeds",\s*\{\s*force: false,\s*\}\s*\)/g,
    "await podcastApi.refreshPodcastFeeds({ force: false })",
  ],
  [
    /await invoke<PodcastEpisode\[\]>\(\s*"podcast_list_related_episodes",\s*\{\s*episodeId,\s*limit: 6,\s*\}\s*\)/g,
    "await podcastApi.listRelatedEpisodes(episodeId, 6)",
  ],
  [
    /await invoke<PodcastChapterDocument>\(\s*"podcast_get_episode_chapters",\s*\{\s*episodeId,\s*\}\s*\)/g,
    "await podcastApi.getEpisodeChapters(episodeId)",
  ],
  [
    /await invoke<PodcastEpisodeDetail>\(\s*"podcast_get_episode_detail",\s*\{\s*episodeId,\s*\}\s*\)/g,
    "await podcastApi.getEpisodeDetail(episodeId)",
  ],
  [
    /await invoke<PodcastEpisodeDetail>\(\s*"podcast_get_episode_detail",\s*\{\s*episodeId: nextEpisodes\[0\]\.id,\s*\}\s*\)/g,
    "await podcastApi.getEpisodeDetail(nextEpisodes[0].id)",
  ],
  [
    /await invoke<PodcastEpisodeDetail>\(\s*"podcast_get_episode_detail",\s*\{\s*episodeId: episode\.id,\s*\}\s*\)/g,
    "await podcastApi.getEpisodeDetail(episode.id)",
  ],
  [
    /await invoke<PodcastDownloadDeleteResult>\(\s*"podcast_delete_episode_downloads",\s*\{\s*episodeIds: intent\.episodeIds,\s*\}\s*\)/g,
    "await podcastApi.deleteEpisodeDownloads(intent.episodeIds)",
  ],
  [
    /await invoke<PodcastDownloadDeleteResult>\(\s*"podcast_clear_completed_downloads",\s*\)/g,
    "await podcastApi.clearCompletedDownloads()",
  ],
  [
    /await invoke<PodcastSearchResult\[\]>\(\s*"podcast_search_apple",\s*\{\s*query: cleanQuery,\s*limit: 18,\s*\}\s*\)/g,
    "await podcastApi.searchApplePodcasts(cleanQuery, 18)",
  ],
  [
    /await invoke<PodcastSubscribeResult>\(\s*"podcast_preview_feed",\s*\{\s*feedUrl: candidate\.feedUrl,/g,
    "await podcastApi.previewPodcastFeed(candidate.feedUrl); void ({",
  ],
];

// preview_feed has multi-line args - handle carefully below
// First apply simple ones
for (const [pattern, replacement] of replacements) {
  next = next.replace(pattern, replacement);
}

// Fix botched preview replacement if any
// Better handle preview/subscribe manually with exact source chunks

// Fix remaining invokes with a more general approach
next = next.replace(
  /await invoke<PodcastSubscribeResult>\(\s*"podcast_preview_feed",\s*\{[\s\S]*?feedUrl: candidate\.feedUrl,[\s\S]*?\}\s*\)/g,
  "await podcastApi.previewPodcastFeed(candidate.feedUrl)",
);
next = next.replace(
  /await invoke<PodcastSubscribeResult>\(\s*"podcast_subscribe",\s*\{\s*feedUrl: cleanUrl,\s*\}\s*\)/g,
  "await podcastApi.subscribePodcastFeed(cleanUrl)",
);
next = next.replace(
  /await invoke<PodcastRefreshReport>\(\s*"podcast_refresh_feeds",\s*\{\s*feedId: selectedFeed\.id,\s*force: true,\s*\}\s*\)/g,
  "await podcastApi.refreshPodcastFeeds({ feedId: selectedFeed.id, force: true })",
);
next = next.replace(
  /await invoke\("podcast_set_following",\s*\{\s*feedId: selectedFeed\.id,\s*following: nextSubscribed,\s*\}\s*\)/g,
  "await podcastApi.setFeedFollowing(selectedFeed.id, nextSubscribed)",
);
next = next.replace(
  /await invoke<PodcastDownloadResult>\(\s*"podcast_download_episode",\s*\{\s*episodeId: episode\.id,\s*\}\s*\)/g,
  "await podcastApi.downloadPodcastEpisode(episode.id)",
);
next = next.replace(
  /await invoke<PodcastEpisodeDetail>\(\s*"podcast_delete_episode_download",\s*\{\s*episodeId: detail\.episode\.id,\s*\}\s*\)/g,
  "await podcastApi.deleteEpisodeDownload(detail.episode.id)",
);
next = next.replace(
  /await invoke<PodcastEpisodeDetail>\(\s*"podcast_set_episode_saved",\s*\{\s*episodeId: detail\.episode\.id,\s*saved: nextSaved,\s*\}\s*\)/g,
  "await podcastApi.setEpisodeSaved(detail.episode.id, nextSaved)",
);

if (next.includes("invoke")) {
  console.warn("Remaining invoke occurrences:");
  for (const line of next.split("\n")) {
    if (line.includes("invoke")) console.warn(line.trim());
  }
}

// Rename export
next = next.replace(
  "export function PodcastView({",
  "export function usePodcastViewModel({",
);

// Append return bag — values needed by shell + screens
const returnBag = `
  return {
    // shell / chrome
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
    // feedback
    notice,
    error,
    setError,
    // listen
    continueListeningEpisodes,
    latestEpisodes,
    filteredLatestEpisodes,
    listenFilter,
    setListenFilter,
    listenNewReferenceTime,
    hasListenContent,
    homeState,
    loadHome,
    // discover
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
    // library
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
    // playlist / queue UI
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
    queueRemovalIntent,
    lastQueueRemovalIntent,
    setQueueRemovalIntent,
    confirmQueueRemoval,
    // show
    displayedEpisodes,
    episodeState,
    loadEpisodes,
    refreshSelectedFeed,
    // episode detail
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
    // overlays
    episodeMenu,
    setEpisodeMenu,
    playEpisodeFromMenu: playEpisode,
    queueEpisodeFromMenu,
    toggleEpisodePlayedFromMenu,
    // feedById for listen isNew
    feedById,
    // props passthrough used by screens
    onRemoveQueueEpisode,
    onReorderQueueEpisode,
  };
}
`;

next = next.trimEnd() + "\n" + returnBag + "\n";

// Fix motion import path - already did
// Fix useLastNonNull path - PodcastView had from "../motion/presence" which we changed

// Remove component imports that are only for JSX if still present
const jsxOnlyImports = [
  `import {
  ContinueCard,
} from "./components/ContinueCard";
`,
];

// Broader cleanup of unused component imports in the model file
next = next.replace(
  /import \{[^}]*ContinueCard[^}]*\} from "\.\/components\/ContinueCard";\n?/g,
  "",
);
next = next.replace(
  /import \{[^}]*EpisodeDetailPanel[^}]*\} from "\.\/components\/EpisodeDetail";\n?/g,
  "",
);
next = next.replace(
  /import \{[^}]*EpisodeRow[^}]*\} from "\.\/components\/EpisodeRows";\n?/g,
  "",
);
next = next.replace(
  /import \{[^}]*QueueEpisodeRow[^}]*\} from "\.\/components\/QueueEpisodeRow";\n?/g,
  "",
);
next = next.replace(
  /import \{[^}]*ShowCard[^}]*DiscoveryShelf[^}]*\} from "\.\/components\/ShowCards";\n?/g,
  "",
);
next = next.replace(
  /import \{[^}]*PodcastDownloadCleanupDialog[^}]*PodcastQueueRemovalDialog[^}]*\} from "\.\/components\/Dialogs";\n?/g,
  "",
);
next = next.replace(
  /import \{[^}]*PodcastActivityIndicator[^}]*PodcastArtwork[^}]*PodcastEmpty[^}]*PodcastLoading[^}]*PodcastSection[^}]*\} from "\.\/components\/primitives";\n?/g,
  "",
);

// Check original import names for components
const importBlock = next.slice(0, 2000);
console.log("--- imports head ---");
console.log(importBlock.split("\n").slice(0, 80).join("\n"));

writeFileSync(sourcePath, next, "utf8");
console.log("Wrote", sourcePath, "lines", next.split("\n").length);
console.log("Remaining invoke?", next.includes("invoke(") || next.includes("invoke<"));
