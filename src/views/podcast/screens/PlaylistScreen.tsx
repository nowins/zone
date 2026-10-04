import { formatTime } from "../../../utils/music";
import { usePodcastBrowsePosition } from "../components/BrowsePosition";
import { PODCAST_AUTO_QUEUE_MODES } from "../constants";
import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { NamedLists } from "../components/NamedLists";
import { formatEpisodeDate, plainText } from "../format";
import { MetroLoader } from "../../../components/MetroLoader";
import { CurrentEpisodeRow } from "../components/EpisodeRows";
import { QueueEpisodeRow } from "../components/QueueEpisodeRow";
import { PodcastEmpty, PodcastSection } from "../components/primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";

let rememberedTab: "queue" | "lists"="queue";
export function PlaylistScreen({ vm }: { vm: PodcastViewModel }) {
  const [tab, setTab] = useState<"queue" | "lists">(rememberedTab);
  useEffect(()=>{rememberedTab=tab;},[tab]);
  useEffect(()=>{if(vm.queueFocusRequest>0)setTab("queue");},[vm.queueFocusRequest]);
  const pageRef=usePodcastBrowsePosition("playlist");
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

  const remaining=upNextQueue.reduce((sum,item)=>sum+(item.episode.durationSeconds?Math.max(0,item.episode.durationSeconds-item.episode.progressSeconds):0),0);
  const unknown=upNextQueue.filter(item=>!item.episode.durationSeconds).length;
  return (
    <main ref={pageRef} className="podcast-screen podcast-playlist-screen">
      <div className="podcast-list-pivots" role="group" aria-label="播放列表分类">
        <Button variant="ghost" aria-pressed={tab === "queue"} onClick={() => setTab("queue")}>待播</Button>
        <Button variant="ghost" aria-pressed={tab === "lists"} onClick={() => setTab("lists")}>我的列表</Button>
      </div>
      {tab === "lists" ? <NamedLists vm={vm} /> :
      <div className="podcast-playlist-content">
              {knownActiveEpisode ? <details className="podcast-playlist-current"><summary>当前单集 · {knownActiveEpisode.title} · {isPlaying?"播放中":"已暂停"}</summary>
                {knownActiveEpisode ? (
                  <CurrentEpisodeRow
                    episode={knownActiveEpisode}
                    isPlaying={isPlaying}
                    onOpen={() => openEpisodeDetail(knownActiveEpisode, "playlist")}
                    onPlay={() => playEpisode(knownActiveEpisode)}
                    onContextMenu={(event) =>
                      showEpisodeMenu(event, knownActiveEpisode)}
                  />
                ) : null}
              </details> : null}
              <p className="podcast-queue-total" role="status">{upNextQueue.length} 集待播 · 剩余音频 {formatTime(remaining)}{vm.playbackRate!==1?` · 按 ${vm.playbackRate}× 约 ${formatTime(remaining/(vm.playbackRate??1))}`:""}{unknown?` · ${unknown} 集时长未知`:""}</p>
              {vm.queueUndoAvailable ? <div className="podcast-queue-undo" role="status">{vm.queueUndoKind === "replace" ? "已替换待播内容" : "已移除待播内容"} <Button variant="ghost" onClick={()=>void vm.onUndoQueueRemoval?.()}>{vm.queueUndoKind === "replace" ? "撤销替换" : "撤销移除"}</Button></div> : null}

              <div className="podcast-auto-queue">
                <span id="podcast-auto-queue-label">播完后</span>
                <div
                  className="podcast-auto-queue-options"
                  role="group"
                  aria-labelledby="podcast-auto-queue-label"
                >
                  {PODCAST_AUTO_QUEUE_MODES.map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      aria-pressed={autoQueueMode === mode.id}
                      onClick={() => onAutoQueueMode(mode.id)}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
                {autoQueueMode !== "off" ? (
                  <small>手动待播优先</small>
                ) : null}
              </div>

              <PodcastSection
                title="待播队列"
                className="podcast-playlist-queue"
                count={upNextQueue.length}
                actionLabel={upNextQueue.length > 0
                  ? queueSelectionMode ? "退出选择" : "选择"
                  : undefined}
                onAction={upNextQueue.length > 0
                  ? toggleQueueSelectionMode
                  : undefined}
              >
                {upNextQueue.length > 0 ? (
                  <>
                    {queueSelectionMode ? (
                      <div
                        className="podcast-queue-batch"
                        role="toolbar"
                        aria-label="批量管理待播"
                      >
                        <span>已选择 {selectedQueueEpisodes.length} 集</span>
                        <button
                          type="button"
                          onClick={toggleAllQueueEpisodes}
                          disabled={Boolean(queueBatchAction)}
                        >
                          {allQueueEpisodesSelected ? "取消全选" : "全选当前待播"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void downloadSelectedQueueEpisodes()}
                          disabled={
                            selectedQueueEpisodes.length === 0
                            || Boolean(queueBatchAction)
                          }
                        >
                          {queueBatchAction === "download" ? (
                            <>
                              <MetroLoader size={14} />
                              正在下载
                            </>
                          ) : "顺序下载"}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void setSelectedQueueEpisodesPlayed(true)}
                          disabled={
                            selectedQueueEpisodes.length === 0
                            || Boolean(queueBatchAction)
                          }
                        >
                          标为已听
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void setSelectedQueueEpisodesPlayed(false)}
                          disabled={
                            selectedQueueEpisodes.length === 0
                            || Boolean(queueBatchAction)
                          }
                        >
                          标为未听
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={requestSelectedQueueRemoval}
                          disabled={
                            selectedQueueEpisodes.length === 0
                            || Boolean(queueBatchAction)
                          }
                        >
                          移除所选
                        </button>
                      </div>
                    ) : (
                      <div className="podcast-queue-toolbar">
                        <p id="podcast-queue-reorder-help">
                          拖动把手调整顺序，也可使用上移和下移按钮。
                        </p>
                        <button
                          type="button"
                          onClick={() => void onClearQueue()}
                        >
                          清空
                        </button>
                      </div>
                    )}
                    <output
                      className="podcast-queue-announcement"
                      aria-live="polite"
                    >
                      {queueAnnouncement}
                    </output>
                    <div
                      className="podcast-queue-list"
                      aria-describedby={
                        queueSelectionMode
                          ? undefined
                          : "podcast-queue-reorder-help"
                      }
                    >
                      {upNextQueue.map((item, index) => {
                        const dropPlacement =
                          queueDropTarget?.episodeId === item.episode.id
                            ? queueDropTarget.placement
                            : undefined;
                        return (
                          <QueueEpisodeRow
                            key={item.episode.id}
                            item={item}
                            index={index}
                            count={upNextQueue.length}
                            selecting={queueSelectionMode}
                            selected={selectedQueueIds.has(item.episode.id)}
                            dragging={
                              draggedQueueEpisodeId === item.episode.id
                            }
                            dropPlacement={dropPlacement}
                            onSelect={() =>
                              toggleQueueSelection(item.episode.id)}
                            onOpen={() =>
                              openEpisodeDetail(item.episode, "playlist")}
                            onPlay={() => playEpisode(item.episode)}
                            onMove={async (direction) => {
                              const moved = await onMoveQueueEpisode(
                                item.episode.id,
                                direction,
                              );
                              if (!moved) return;
                              setQueueAnnouncement(
                                `已将“${item.episode.title}”移到第 ${
                                  index + direction + 1
                                } 位`,
                              );
                            }}
                            onRemove={() =>
                              void onRemoveQueueEpisode(item.episode.id)}
                            onDragStart={(event) =>
                              handleQueueDragStart(event, item.episode.id)}
                            onDragOver={(event) =>
                              handleQueueDragOver(event, item.episode.id)}
                            onDrop={(event) =>
                              handleQueueDrop(event, item.episode.id)}
                            onDragEnd={resetQueueDrag}
                            onContextMenu={(event) =>
                              showEpisodeMenu(event, item.episode)}
                          />
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <><PodcastEmpty label="待播队列为空，可从单集详情加入" /><Button variant="ghost" onClick={()=>changeRootScreen("discover")}>去发现节目</Button></>
                )}
              </PodcastSection>
      </div>}
            </main>
  );
}
