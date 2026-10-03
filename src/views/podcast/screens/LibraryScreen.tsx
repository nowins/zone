import { ArrowLeft, ArrowRight } from "lucide-react";
import { useState } from "react";
import { ShowGroups } from "../components/ShowGroups";
import { DownloadJobs } from "../components/DownloadJobs";
import { TransferActions } from "../components/TransferActions";
import { EpisodeBrowser } from "../components/EpisodeBrowser";
import { isPodcastEpisodeNew } from "../../../utils/podcastListening";
import { PODCAST_LIBRARY_SORTS, PODCAST_DOWNLOAD_BATCH_LIMIT } from "../constants";
import { formatEpisodeDate, formatFileSize } from "../format";
import { MetroLoader } from "../../../components/MetroLoader";
import { EpisodeRow } from "../components/EpisodeRows";
import {
  PodcastArtwork,
  PodcastEmpty,
  PodcastLoading,
  PodcastSection,
} from "../components/primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";

export function LibraryScreen({ vm }: { vm: PodcastViewModel }) {
  const [groupFeedIds, setGroupFeedIds] = useState<ReadonlySet<string> | null>(null);
  const groupedFeeds = vm.orderedFeeds.filter(feed => !groupFeedIds || groupFeedIds.has(feed.id));
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
    downloadCleanupAction,
  } = vm;

  return (
    <main className="podcast-screen podcast-library-screen">
              <TransferActions />
              <DownloadJobs />
              <EpisodeBrowser vm={vm} />
              <PodcastSection title="已关注" count={feeds.length}>
                {libraryState === "loading" ? (
                  <PodcastLoading label="正在读取资料库" />
                ) : feeds.length > 0 ? (
                  <>
                    <div
                      className="podcast-listen-filters podcast-library-sorts"
                      role="group"
                      aria-label="已关注节目排序"
                    >
                      {PODCAST_LIBRARY_SORTS.map((sort) => (
                        <button
                          key={sort.id}
                          type="button"
                          aria-pressed={librarySort === sort.id}
                          onClick={() => setLibrarySort(sort.id)}
                        >
                          {sort.label}
                        </button>
                      ))}
                    </div>
                    <ShowGroups feeds={feeds} revision={vm.libraryRevision} onFilter={setGroupFeedIds} />
                    {groupedFeeds.length === 0 ? <PodcastEmpty label="这个分组还没有关注的节目" /> : null}
                    <div className="podcast-library-grid">
                      {groupedFeeds.map((feed, index) => (
                        <article
                          key={feed.id}
                          className="podcast-library-show"
                        >
                          <button
                            type="button"
                            className="podcast-library-show-open"
                            onClick={() => void openStoredFeed(feed, "library")}
                          >
                            <span className="podcast-library-artwork">
                              <PodcastArtwork
                                url={feed.artworkUrl}
                                title={feed.title}
                              />
                              {feed.unplayedCount > 0 ? (
                                <em
                                  className="podcast-unplayed-badge"
                                  aria-label={`${feed.unplayedCount} 集未听`}
                                >
                                  {feed.unplayedCount > 99
                                    ? "99+"
                                    : feed.unplayedCount}
                                </em>
                              ) : null}
                            </span>
                            <span className="podcast-library-show-copy">
                              <strong>{feed.title}</strong>
                              <small>{feed.author || "未知作者"}</small>
                              <small className="podcast-library-updated">
                                {feed.latestEpisodeAt
                                  ? `最近更新 ${formatEpisodeDate(
                                    feed.latestEpisodeAt,
                                  )}`
                                  : "暂无单集"}
                              </small>
                            </span>
                          </button>
                          {librarySort === "custom" ? (
                            <span
                              className="podcast-library-order"
                              aria-label={`调整“${feed.title}”的位置`}
                            >
                              <button
                                type="button"
                                onClick={() => moveFollowedFeed(feed.id, -1, groupedFeeds.map(feed => feed.id))}
                                disabled={index === 0}
                                title="前移"
                                aria-label={`将“${feed.title}”前移`}
                              >
                                <ArrowLeft size={15} />
                              </button>
                              <button
                                type="button"
                                onClick={() => moveFollowedFeed(feed.id, 1, groupedFeeds.map(feed => feed.id))}
                                disabled={index === groupedFeeds.length - 1}
                                title="后移"
                                aria-label={`将“${feed.title}”后移`}
                              >
                                <ArrowRight size={15} />
                              </button>
                            </span>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  </>
                ) : (
                  <PodcastEmpty label="还没有关注节目，可以先去发现看看" />
                )}
              </PodcastSection>

              {recentlyPlayedEpisodes.length > 0 ? (
                <PodcastSection
                  title="最近播放"
                  count={recentlyPlayedEpisodes.length}
                  actionLabel={recentlyPlayedEpisodes.length > 8
                    ? recentHistoryExpanded ? "收起" : "查看全部"
                    : undefined}
                  onAction={recentlyPlayedEpisodes.length > 8
                    ? () => setRecentHistoryExpanded((current) => !current)
                    : undefined}
                >
                  <div className="podcast-home-episodes">
                    {(recentHistoryExpanded
                      ? recentlyPlayedEpisodes
                      : recentlyPlayedEpisodes.slice(0, 8)
                    ).map((episode) => (
                      <EpisodeRow
                        key={episode.id}
                        episode={episode}
                        active={currentEpisodeId === episode.id}
                        isPlaying={isPlaying}
                        downloading={downloadingId === episode.id}
                        showFeed
                        onOpen={() => openEpisodeDetail(episode, "library")}
                        onPlay={() => playEpisode(episode)}
                        onDownload={() => void downloadEpisode(episode)}
                        onContextMenu={(event) =>
                          showEpisodeMenu(event, episode)}
                      />
                    ))}
                  </div>
                </PodcastSection>
              ) : null}

              {savedEpisodes.length > 0 ? (
                <PodcastSection title="稍后听" count={savedEpisodes.length}>
                  <div className="podcast-home-episodes">
                    {savedEpisodes.map((episode) => (
                      <EpisodeRow
                        key={episode.id}
                        episode={episode}
                        active={currentEpisodeId === episode.id}
                        isPlaying={isPlaying}
                        downloading={downloadingId === episode.id}
                        showFeed
                        onOpen={() => openEpisodeDetail(episode, "library")}
                        onPlay={() => playEpisode(episode)}
                        onDownload={() => void downloadEpisode(episode)}
                        onContextMenu={(event) =>
                          showEpisodeMenu(event, episode)}
                      />
                    ))}
                  </div>
                </PodcastSection>
              ) : null}

              {downloadedCount > 0 || downloadLibraryState === "loading"
                || downloadLibraryState === "error" ? (
                <PodcastSection
                  title="已下载"
                  count={downloadedCount}
                >
                  {downloadedCount > 0 ? (
                    <>
                      <div className="podcast-download-summary">
                        <span>
                          已下载占用 {formatFileSize(downloadedBytes)}
                        </span>
                        <span>{downloadedFeedCount} 个节目</span>
                        <div className="podcast-download-summary-actions">
                          <button
                            type="button"
                            aria-pressed={downloadSelectionMode}
                            onClick={toggleDownloadSelectionMode}
                            disabled={Boolean(downloadCleanupAction)}
                          >
                            {downloadSelectionMode ? "退出选择" : "选择"}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setDownloadCleanupIntent({ kind: "completed" })}
                            disabled={Boolean(downloadCleanupAction)}
                          >
                            清理已听完
                          </button>
                        </div>
                      </div>
                      {downloadSelectionMode ? (
                        <div
                          className="podcast-download-batch"
                          role="toolbar"
                          aria-label="批量管理下载"
                        >
                          <span>已选择 {selectedDownloadIds.size} 集</span>
                          <button
                            type="button"
                            onClick={toggleAllLoadedDownloads}
                          >
                            {allLoadedDownloadsSelected
                              ? "取消全选"
                              : loadedDownloadsExceedBatchLimit
                                ? `选择前 ${PODCAST_DOWNLOAD_BATCH_LIMIT} 集`
                                : "全选已加载"}
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={requestSelectedDownloadDeletion}
                            disabled={selectedDownloadIds.size === 0}
                          >
                            删除所选
                          </button>
                        </div>
                      ) : null}
                      <div className="podcast-download-groups">
                        {downloadGroups.map((group) => (
                          <section
                            key={group.feedId}
                            className="podcast-download-group"
                          >
                            <div className="podcast-download-group-title">
                              <h3>{group.feedTitle}</h3>
                              <span>
                                {group.episodes.length} 集 ·{" "}
                                {formatFileSize(group.downloadedBytes)}
                              </span>
                            </div>
                            <div className="podcast-home-episodes">
                              {group.episodes.map((episode) => (
                                <EpisodeRow
                                  key={episode.id}
                                  episode={episode}
                                  active={currentEpisodeId === episode.id}
                                  isPlaying={isPlaying}
                                  downloading={false}
                                  showDownloadedSize
                                  selecting={downloadSelectionMode}
                                  selected={selectedDownloadIds.has(episode.id)}
                                  onSelect={() =>
                                    toggleDownloadSelection(episode.id)}
                                  onOpen={() =>
                                    openEpisodeDetail(episode, "library")}
                                  onPlay={() => playEpisode(episode)}
                                  onDownload={() => undefined}
                                  onContextMenu={(event) =>
                                    showEpisodeMenu(event, episode)}
                                />
                              ))}
                            </div>
                          </section>
                        ))}
                      </div>
                      {downloadPage.hasMore ? (
                        <button
                          type="button"
                          className="podcast-download-more"
                          disabled={
                            loadingMoreDownloads
                            || downloadLibraryState === "loading"
                          }
                          onClick={() =>
                            void loadDownloadedLibrary(
                              downloadPage.episodes.length,
                            )}
                        >
                          {loadingMoreDownloads ? (
                            <>
                              <MetroLoader size={15} />
                              正在加载
                            </>
                          ) : "加载更多"}
                        </button>
                      ) : null}
                    </>
                  ) : downloadLibraryState === "loading" ? (
                    <PodcastLoading label="正在读取下载资料库" />
                  ) : (
                    <div className="podcast-inline-state">
                      <span>暂时无法读取下载资料库</span>
                      <button
                        type="button"
                        onClick={() => void loadDownloadedLibrary(0)}
                      >
                        重试
                      </button>
                    </div>
                  )}
                </PodcastSection>
              ) : null}
            </main>
  );
}
