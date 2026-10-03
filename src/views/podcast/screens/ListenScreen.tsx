import { usePodcastBrowsePosition } from "../components/BrowsePosition";
import { isPodcastEpisodeNew } from "../../../utils/podcastListening";
import { PODCAST_LISTEN_FILTERS } from "../constants";
import { ContinueCard } from "../components/ContinueCard";
import { EpisodeRow } from "../components/EpisodeRows";
import {
  PodcastEmpty,
  PodcastLoading,
  PodcastSection,
} from "../components/primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";
import { useState } from "react";
import { Button } from "../../../components/Button";
import { EpisodeBrowser } from "../components/EpisodeBrowser";

export function ListenScreen({ vm }: { vm: PodcastViewModel }) {
  const [expanded,setExpanded]=useState<"continue"|"updates"|null>(null);
  const pageRef=usePodcastBrowsePosition("listen");
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

  return (
    <main ref={pageRef} className="podcast-screen podcast-listen-screen">
      {expanded ? <><Button variant="ghost" onClick={()=>setExpanded(null)}>返回收听</Button><h2>{expanded==="continue"?"全部继续收听":"来自你的节目"}</h2><EpisodeBrowser key={expanded} scope={`listen-${expanded}`} vm={vm} initialFilter={expanded==="continue"?"in-progress":listenFilter==="unplayed"?"unstarted":"all"} initialSort={expanded==="continue"?"listened":"newest"} followedOnly={expanded==="updates"}/></> : <>
              {continueListeningEpisodes.length > 0 ? (
                <PodcastSection title="继续收听" count={continueListeningEpisodes.length} actionLabel="查看全部" onAction={()=>setExpanded("continue")}>
                  <div className="podcast-continue-grid">
                    {continueListeningEpisodes.map((episode) => (
                      <ContinueCard
                        key={episode.id}
                        episode={episode}
                        active={currentEpisodeId === episode.id}
                        isPlaying={isPlaying}
                        onOpen={() => openEpisodeDetail(episode, "listen")}
                        onPlay={() => playEpisode(episode)}
                        onContextMenu={(event) =>
                          showEpisodeMenu(event, episode)}
                      />
                    ))}
                  </div>
                </PodcastSection>
              ) : null}

              {latestEpisodes.length > 0 ? (
                <PodcastSection
                  title="来自你的节目"
                  count={filteredLatestEpisodes.length}
                  actionLabel="查看全部" onAction={()=>setExpanded("updates")}
                >
                  <div
                    className="podcast-listen-filters"
                    role="group"
                    aria-label="筛选来自你的节目"
                  >
                    {PODCAST_LISTEN_FILTERS.map((filter) => (
                      <button
                        key={filter.id}
                        type="button"
                        aria-pressed={listenFilter === filter.id}
                        onClick={() => setListenFilter(filter.id)}
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                  {filteredLatestEpisodes.length > 0 ? (
                    <div className="podcast-home-episodes">
                      {filteredLatestEpisodes.slice(0, 8).map((episode) => (
                        <EpisodeRow
                          key={episode.id}
                          episode={episode}
                          active={currentEpisodeId === episode.id}
                          isPlaying={isPlaying}
                          downloading={downloadingId === episode.id}
                          showFeed
                          showArtwork
                          isNew={isPodcastEpisodeNew(
                            episode,
                            feedById.get(episode.feedId)?.subscribedAt,
                            listenNewReferenceTime,
                          )}
                          onOpen={() => openEpisodeDetail(episode, "listen")}
                          onPlay={() => playEpisode(episode)}
                          onDownload={() => void downloadEpisode(episode)}
                          onContextMenu={(event) =>
                            showEpisodeMenu(event, episode)}
                        />
                      ))}
                    </div>
                  ) : (
                    <PodcastEmpty label="没有未收听的单集" />
                  )}
                </PodcastSection>
              ) : null}

              {!hasListenContent ? (
                <PodcastSection title="开始收听">
                  {homeState === "loading" ? (
                    <PodcastLoading label="正在整理你的节目" />
                  ) : homeState === "error" ? (
                    <div className="podcast-inline-state">
                      <span>暂时无法整理收听内容</span>
                      <button type="button" onClick={() => void loadHome()}>重试</button>
                    </div>
                  ) : (
                    <PodcastEmpty
                      label="关注节目后，新单集会出现在这里"
                      actionLabel="去发现"
                      onAction={() => changeRootScreen("discover")}
                    />
                  )}
                </PodcastSection>
              ) : null}
      </>}</main>
  );
}
