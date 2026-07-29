import { EpisodeDetail } from "../components/EpisodeDetail";
import { EpisodeRow } from "../components/EpisodeRows";
import {
  PodcastEmpty,
  PodcastLoading,
  PodcastSection,
} from "../components/primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";

export function EpisodeScreen({ vm }: { vm: PodcastViewModel }) {
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
    selectedEpisodeDetail,
  } = vm;

  return (
    <main className="podcast-screen podcast-detail-screen">
              {detailState === "loading" && !selectedEpisodeDetail ? (
                <PodcastLoading label="正在读取单集详情" />
              ) : displayedEpisodeDetail ? (
                <>
                  <EpisodeDetail
                    detail={displayedEpisodeDetail}
                    active={currentEpisodeId === displayedEpisodeDetail.episode.id}
                    isPlaying={isPlaying}
                    downloading={
                      downloadingId === displayedEpisodeDetail.episode.id
                    }
                    action={detailAction}
                    queuePosition={detailQueuePosition}
                    chapterDocument={chapterDocument}
                    chapterState={chapterState}
                    chaptersOpen={chaptersOpen}
                    activeProgress={activeProgress}
                    onPlay={() => playEpisode(displayedEpisodeDetail.episode)}
                    onPlayNext={() =>
                      void onQueueEpisode(displayedEpisodeDetail.episode, true)}
                    onAddQueue={() =>
                      void onQueueEpisode(displayedEpisodeDetail.episode, false)}
                    onToggleSaved={() =>
                      void toggleEpisodeSaved(displayedEpisodeDetail)}
                    onDownload={() =>
                      void downloadEpisode(displayedEpisodeDetail.episode)}
                    onDeleteDownload={() =>
                      void deleteEpisodeDownload(displayedEpisodeDetail)}
                    onTogglePlayed={() =>
                      void toggleEpisodePlayed(displayedEpisodeDetail)}
                    onOpenShow={() => void openEpisodeShow()}
                    onToggleChapters={toggleEpisodeChapters}
                    onRetryChapters={() =>
                      void loadEpisodeChapters(
                        displayedEpisodeDetail.episode.id,
                        true,
                      )}
                    onPlayChapter={(positionSeconds) =>
                      playEpisodeAt(
                        displayedEpisodeDetail.episode,
                        positionSeconds,
                      )}
                  />
                  {relatedState === "loading" ? (
                    <div className="podcast-detail-related">
                      <PodcastSection title="该节目的其他单集">
                        <PodcastLoading label="正在整理其他单集" />
                      </PodcastSection>
                    </div>
                  ) : displayedRelatedEpisodes.length > 0 ? (
                    <div className="podcast-detail-related">
                      <PodcastSection
                        title="该节目的其他单集"
                        actionLabel="查看全部"
                        onAction={() => void openEpisodeShow()}
                      >
                        <div className="podcast-detail-related-list">
                          {displayedRelatedEpisodes.map((episode) => (
                            <EpisodeRow
                              key={episode.id}
                              episode={episode}
                              active={currentEpisodeId === episode.id}
                              isPlaying={isPlaying}
                              downloading={downloadingId === episode.id}
                              onOpen={() => openEpisodeDetail(episode)}
                              onPlay={() => playEpisode(episode)}
                              onDownload={() => void downloadEpisode(episode)}
                              onContextMenu={(event) =>
                                showEpisodeMenu(event, episode)}
                            />
                          ))}
                        </div>
                      </PodcastSection>
                    </div>
                  ) : relatedState === "error" ? (
                    <div className="podcast-detail-related">
                      <PodcastSection title="该节目的其他单集">
                        <PodcastEmpty
                          label="暂时无法读取其他单集"
                          actionLabel="重试"
                          onAction={() =>
                            void loadRelatedEpisodes(
                              displayedEpisodeDetail.episode.id,
                            )}
                        />
                      </PodcastSection>
                    </div>
                  ) : null}
                </>
              ) : detailState === "error" ? (
                <PodcastEmpty label="无法读取这集内容，可以返回后重试" />
              ) : (
                <PodcastLoading label="正在准备单集详情" />
              )}
            </main>
  );
}
