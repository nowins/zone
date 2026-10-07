import { ListeningStats } from "../components/ListeningStats";
import { usePodcastBrowsePosition } from "../components/BrowsePosition";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useState, useRef } from "react";
import { useBrowsePanelMotion } from "../../../hooks/useBrowseEntrance";
import { ShowGroups } from "../components/ShowGroups";
import { DownloadJobs } from "../components/DownloadJobs";
import { DownloadStorage } from "../components/DownloadStorage";
import { TransferActions } from "../components/TransferActions";
import { EpisodeBrowser } from "../components/EpisodeBrowser";
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

let libraryTab="shows";
export function LibraryScreen({ vm }: { vm: PodcastViewModel }) {
  const [tab,setTab]=useState(libraryTab);
  useEffect(()=>{libraryTab=tab;},[tab]);
  const [groupFeedIds, setGroupFeedIds] = useState<ReadonlySet<string> | null>(null);
  const groupedFeeds = vm.orderedFeeds.filter(feed => !groupFeedIds || groupFeedIds.has(feed.id));
  const pageRef=usePodcastBrowsePosition("library");
  const contentRef = useRef<HTMLDivElement>(null);
  useBrowsePanelMotion(contentRef, tab, ["shows", "episodes", "saved", "downloads", "history", "manage"]);
  const { currentEpisodeId, isPlaying, openEpisodeDetail, playEpisode, showEpisodeMenu, feeds, libraryState, librarySort, setLibrarySort, openStoredFeed, moveFollowedFeed, downloadLibraryState, downloadGroups, downloadedBytes, downloadedCount, downloadedFeedCount, downloadPage, loadDownloadedLibrary, loadingMoreDownloads, downloadSelectionMode, toggleDownloadSelectionMode, toggleAllLoadedDownloads, allLoadedDownloadsSelected, loadedDownloadsExceedBatchLimit, selectedDownloadIds, toggleDownloadSelection, requestSelectedDownloadDeletion, setDownloadCleanupIntent, episodes, downloadCleanupAction } = vm;

  return (
    <main ref={pageRef} className="podcast-screen podcast-library-screen">
      <div className="podcast-library-tabs" role="group" aria-label="资料库分类">{[["shows","节目"],["episodes","单集"],["saved","稍后听"],["downloads","下载"],["history","历史"],["manage","管理"]].map(([id,label])=><button key={id} type="button" aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</div>
      <div ref={contentRef} className="podcast-tab-content">
      {tab==="manage" ? <TransferActions /> : null}
      {tab==="downloads" ? <><DownloadStorage revision={vm.libraryRevision} /><DownloadJobs /></> : null}
      {tab==="episodes" ? <EpisodeBrowser key="archive" vm={vm} scope="archive"/> : null}
      {tab==="saved" ? <EpisodeBrowser key="saved" vm={vm} scope="saved" initialFilter="saved"/> : null}
      {tab==="history" ? <><ListeningStats revision={vm.libraryRevision}/><EpisodeBrowser key="history" vm={vm} scope="history" initialFilter="history" initialSort="listened"/></> : null}
      {tab==="shows" ? <>
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
                                  aria-label={`${feed.unplayedCount} 集未听完，包含历史单集`} title="未听完数量，包含历史单集"
                                >
                                  {feed.unplayedCount > 99
                                    ? "99+"
                                    : feed.unplayedCount}
                                </em>
                              ) : null}
                            </span>
                            <span className="podcast-library-show-copy">
                              <strong title={feed.title}>{feed.title}</strong>
                              <small>{feed.unplayedCount} 集未听完{feed.latestEpisodeAt && feed.latestEpisodeAt>=Date.now()-86400000 ? " · 24 小时内更新" : ""}</small>
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

      </> : null}
              {tab==="downloads" ? (
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
                  ) : downloadLibraryState === "error" ? (
                    <div className="podcast-inline-state">
                      <span>暂时无法读取下载资料库</span>
                      <button
                        type="button"
                        onClick={() => void loadDownloadedLibrary(0)}
                      >
                        重试
                      </button>
                    </div>
                  ) : <PodcastEmpty label="还没有下载，选择单集下载后可离线收听" />}
                </PodcastSection>
              ) : null}
      </div>
            </main>
  );
}
