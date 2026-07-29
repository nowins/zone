/**
 * Rebuild PodcastView.tsx as a thin shell over usePodcastViewModel + extracted JSX.
 */
import { readFileSync, writeFileSync } from "node:fs";

const jsx = readFileSync("src/views/podcast/_jsx_extract.txt", "utf8");
// jsx starts with `  return (\n    <section...` and ends with `  );\n}\n` or similar

// Drop the trailing `}` of the old function if present
let body = jsx.trimEnd();
if (body.endsWith("}")) {
  // ends with `);\n}`
  body = body.replace(/\n\}\s*$/, "");
}

const shell = `import {
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  LoaderCircle,
  RefreshCw,
  Rss,
  Search,
} from "lucide-react";
import {
  PodcastEpisodeContextMenu,
} from "../components/PodcastEpisodeContextMenu";
import { Presence } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";
import { isPodcastEpisodeNew } from "../utils/podcastListening";
import type { PodcastViewProps } from "./podcast/types";
import {
  PODCAST_AUTO_QUEUE_MODES,
  PODCAST_DISCOVERY_SORTS,
  PODCAST_DISCOVERY_TOPICS,
  PODCAST_LIBRARY_SORTS,
  PODCAST_LISTEN_FILTERS,
} from "./podcast/constants";
import { rootScreenLabel } from "./podcast/episodeModel";
import { formatFileSize } from "./podcast/format";
import {
  PodcastActivityIndicator,
  PodcastArtwork,
  PodcastEmpty,
  PodcastLoading,
  PodcastSection,
} from "./podcast/components/primitives";
import {
  CurrentEpisodeRow,
  EpisodeRow,
} from "./podcast/components/EpisodeRows";
import { QueueEpisodeRow } from "./podcast/components/QueueEpisodeRow";
import { EpisodeDetail } from "./podcast/components/EpisodeDetail";
import { ContinueCard } from "./podcast/components/ContinueCard";
import { DiscoveryShelf, ShowCard } from "./podcast/components/ShowCards";
import {
  PodcastDownloadCleanupDialog,
  PodcastQueueRemovalDialog,
} from "./podcast/components/Dialogs";
import { usePodcastViewModel } from "./podcast/usePodcastViewModel";

export function PodcastView(props: PodcastViewProps) {
  const {
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
  } = usePodcastViewModel(props);

${body}
}
`;

writeFileSync("src/views/PodcastView.tsx", shell, "utf8");
console.log("Wrote PodcastView.tsx lines", shell.split("\n").length);
