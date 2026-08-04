import { Search, Rss } from "lucide-react";
import { MetroLoader } from "../../../components/MetroLoader";
import {
  PODCAST_DISCOVERY_SORTS,
  PODCAST_DISCOVERY_TOPICS,
} from "../constants";
import { DiscoveryShelf, ShowCard } from "../components/ShowCards";
import {
  PodcastEmpty,
  PodcastLoading,
  PodcastSection,
} from "../components/primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";

export function DiscoverScreen({ vm }: { vm: PodcastViewModel }) {
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
    <main className="podcast-screen podcast-discover-screen">
              <div className="podcast-discovery-search-row">
                <form className="podcast-search-form" onSubmit={searchApple}>
                  <Search size={17} aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索节目、人物或主题…"
                    aria-label="搜索播客"
                  />
                  <button
                    type="submit"
                    disabled={!query.trim()}
                  >
                    {searchState === "loading" && discoveryTopic === null
                      ? (
                        <span className="podcast-button-loading">
                          <MetroLoader />
                          搜索中
                        </span>
                      )
                      : "搜索"}
                  </button>
                </form>
                <button
                  className="podcast-rss-toggle"
                  type="button"
                  aria-expanded={rssExpanded}
                  aria-controls="podcast-rss-subscribe"
                  onClick={() => setRssExpanded((expanded) => !expanded)}
                >
                  + RSS
                </button>
              </div>

              {rssExpanded ? (
                <div
                  id="podcast-rss-subscribe"
                  className="podcast-rss-entry"
                >
                  <form onSubmit={subscribeRss}>
                    <Rss size={15} aria-hidden="true" />
                    <input
                      value={rssUrl}
                      onChange={(event) => setRssUrl(event.target.value)}
                      placeholder="粘贴公开 RSS 地址"
                      aria-label="RSS 地址"
                      autoFocus
                    />
                    <button
                      type="submit"
                      disabled={!rssUrl.trim() || Boolean(openingId)}
                    >
                      关注
                    </button>
                  </form>
                </div>
              ) : null}

              <div
                className="podcast-discovery-topics"
                role="group"
                aria-label="按主题浏览"
              >
                <span>按主题浏览</span>
                <div>
                  {PODCAST_DISCOVERY_TOPICS.map((topic) => (
                    <button
                      key={topic.id}
                      type="button"
                      aria-pressed={discoveryTopic === topic.id}
                      onClick={() => browseDiscoveryTopic(topic.id)}
                    >
                      {topic.label}
                    </button>
                  ))}
                </div>
              </div>

              {searchHistory.length > 0 ? (
                <div className="podcast-search-history">
                  <div>
                    <span>最近搜索</span>
                    <button
                      type="button"
                      onClick={() => setSearchHistory([])}
                    >
                      清空
                    </button>
                  </div>
                  <ul aria-label="最近搜索">
                    {searchHistory.map((historyQuery) => (
                      <li key={historyQuery}>
                        <button
                          type="button"
                          onClick={() => repeatPodcastSearch(historyQuery)}
                        >
                          {historyQuery}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {searchState !== "idle" ? (
                <PodcastSection
                  title={searchState === "loading" ? "正在搜索" : searchHeading}
                  count={searchResults.length}
                  actionLabel="返回热门"
                  onAction={showPopularDiscovery}
                >
                  {searchState === "loading" ? (
                    <PodcastLoading label="正在查找节目" />
                  ) : searchState === "error" ? (
                    <PodcastEmpty label="暂时无法完成搜索" />
                  ) : searchResults.length > 0 ? (
                    <>
                      <div
                        className="podcast-search-sorts"
                        role="group"
                        aria-label="搜索结果排序"
                      >
                        <span>排序</span>
                        <div>
                          {PODCAST_DISCOVERY_SORTS.map((option) => (
                            <button
                              key={option.id}
                              type="button"
                              aria-pressed={searchSort === option.id}
                              onClick={() => setSearchSort(option.id)}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="podcast-search-grid">
                        {sortedSearchResults.map((result) => (
                          <ShowCard
                            key={result.id}
                            show={result}
                            followed={feeds.some(
                              (feed) => feed.feedUrl === result.feedUrl,
                            )}
                            highlightQuery={searchHighlightQuery}
                            loading={openingId === result.id}
                            onOpen={() => void previewFeed(result, "discover")}
                            showSearchMetadata
                          />
                        ))}
                      </div>
                    </>
                  ) : (
                    <PodcastEmpty label="没有找到相关节目" />
                  )}
                </PodcastSection>
              ) : (
                <PodcastSection title="中国区热门节目" count={discoveryShows.length}>
                  <DiscoveryShelf
                    state={discoveryState}
                    shows={discoveryShows}
                    feeds={feeds}
                    openingId={openingId}
                    onOpen={(show) => void previewFeed(show, "discover")}
                    onRetry={() => void loadDiscovery()}
                  />
                </PodcastSection>
              )}
            </main>
  );
}
