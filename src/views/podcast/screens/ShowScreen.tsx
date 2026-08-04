import { RefreshCw } from "lucide-react";
import { plainText } from "../format";
import { MetroLoader } from "../../../components/MetroLoader";
import { EpisodeRow } from "../components/EpisodeRows";
import {
  PodcastArtwork,
  PodcastEmpty,
  PodcastLoading,
} from "../components/primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";

export function ShowScreen({ vm }: { vm: PodcastViewModel }) {
  const {
    // pull fields used by this screen (full bag is fine; unused locals are ok at runtime)
    ..._
  } = vm;
  void _;
  // Prefer explicit access via vm.* for readability of auto-extract; bind common names:
  const {
    continueListeningEpisodes,
    latestEpisodes,
    filteredLatestEpisodes,
    listenFilter,
    setListenFilter,
    listenNewReferenceTime,
    hasListenContent,
    homeState,
    loadHome,
    currentEpisodeId,
    isPlaying,
    openEpisodeDetail,
    playEpisode,
    showEpisodeMenu,
    downloadingId,
    downloadEpisode,
    feedById,
    changeRootScreen,
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
    knownActiveEpisode,
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
    setQueueAnnouncement,
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
    selectedFeed,
    displayedEpisodes,
    episodeState,
    loadEpisodes,
    refreshSelectedFeed,
    following,
    displayedEpisodeDetail,
    detailState,
    liveActiveEpisode,
    activeProgress,
    activeDuration,
    detailQueuePosition,
    detailAction,
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
    deleteEpisodeDownload,
    shareEpisode,
    displayedRelatedEpisodes,
    relatedState,
    loadRelatedEpisodes,
    openEpisodeShow,
    episodes,
  } = vm;

  if (!selectedFeed) return null;

  return (
    <main className="podcast-screen podcast-show-screen">
              <section className="podcast-show-hero">
                <PodcastArtwork
                  url={selectedFeed.artworkUrl}
                  title={selectedFeed.title}
                  large
                />
                <div>
                  <span>{selectedFeed.subscribed ? "已加入资料库" : "公开播客"}</span>
                  <h2>{selectedFeed.title}</h2>
                  <strong>{selectedFeed.author || "未知作者"}</strong>
                  {selectedFeed.description
                    ? <p>{plainText(selectedFeed.description)}</p>
                    : null}
                </div>
                <button
                  type="button"
                  className="podcast-refresh"
                  onClick={() => void refreshSelectedFeed()}
                  disabled={Boolean(openingId)}
                  title="刷新节目"
                >
                  {openingId === selectedFeed.id
                    ? <MetroLoader size={16} />
                    : <RefreshCw size={16} />}
                  刷新
                </button>
              </section>

              <section className="podcast-show-episodes">
                <div className="podcast-section-title">
                  <h2>单集</h2>
                  <span>{displayedEpisodes.length}</span>
                </div>
                {episodeState === "loading" && episodes.length === 0 ? (
                  <PodcastLoading label="正在读取单集" />
                ) : displayedEpisodes.length > 0 ? (
                  displayedEpisodes.map((episode) => (
                    <EpisodeRow
                      key={episode.id}
                      episode={episode}
                      active={currentEpisodeId === episode.id}
                      isPlaying={isPlaying}
                      downloading={downloadingId === episode.id}
                      onOpen={() => openEpisodeDetail(episode, "show")}
                      onPlay={() => playEpisode(episode)}
                      onDownload={() => void downloadEpisode(episode)}
                      onContextMenu={(event) =>
                        showEpisodeMenu(event, episode)}
                    />
                  ))
                ) : (
                  <PodcastEmpty label="这个节目还没有可播放的单集" />
                )}
              </section>
            </main>
  );
}
