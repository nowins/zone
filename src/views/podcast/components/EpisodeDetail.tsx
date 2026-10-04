import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { Presence } from "../../../motion/presence";
import { MOTION_DURATIONS } from "../../../motion/tokens";
import { PlaylistPicker } from "./NamedLists";
import {
  Bookmark,
  CheckCircle2,
  ChevronDown,
  Download,
  ListMusic,
  Pause,
  Play,
  RefreshCw,
  SkipForward,
  Trash2,
} from "lucide-react";
import { MetroLoader } from "../../../components/MetroLoader";
import { formatTime } from "../../../utils/music";
import { findActivePodcastChapterIndex } from "../../../utils/podcastChapters";
import type {
  PodcastChapterDocument,
  PodcastEpisodeDetail,
} from "../../../types";
import type { RequestState } from "../types";
import {
  formatEpisodeFullDate,
  plainText,
  podcastDownloadProgressLabel,
} from "../format";
import { PodcastArtwork, PodcastEmpty, PodcastLoading } from "./primitives";
import { PodcastNotes, PodcastExternalLink } from "./Notes";
import { TranscriptPanel } from "./TranscriptPanel";
import { EpisodeBookmarks } from "./Bookmarks";

function EpisodeDetail({
  detail,
  active,
  isPlaying,
  downloading,
  action,
  queuePosition,
  chapterDocument,
  chapterState,
  chaptersOpen,
  activeProgress,
  onPlay,
  onPlayNext,
  onAddQueue,
  onToggleSaved,
  onDownload,
  onDeleteDownload,
  onTogglePlayed,
  onOpenShow,
  onToggleChapters,
  onRetryChapters,
  onPlayChapter,
}: {
  detail: PodcastEpisodeDetail;
  active: boolean;
  isPlaying: boolean;
  downloading: boolean;
  action: "save" | "played" | "delete" | null;
  queuePosition: number;
  chapterDocument: PodcastChapterDocument | null;
  chapterState: RequestState;
  chaptersOpen: boolean;
  activeProgress: number;
  onPlay: () => void;
  onPlayNext: () => void;
  onAddQueue: () => void;
  onToggleSaved: () => void;
  onDownload: () => void;
  onDeleteDownload: () => void;
  onTogglePlayed: () => void;
  onOpenShow: () => void;
  onToggleChapters: () => void;
  onRetryChapters: () => void;
  onPlayChapter: (positionSeconds: number) => void;
}) {
  const { episode, feed } = detail;
  const [reading, setReading] = useState("notes");
  useEffect(() => setReading("notes"), [episode.id]);
  const [addingToList, setAddingToList] = useState(false);
  const currentChapterIndex = active && chapterDocument
    ? findActivePodcastChapterIndex(
      chapterDocument.chapters,
      activeProgress,
    )
    : -1;
  const chapterPanelId = `podcast-chapters-${episode.id}`;
  const playLabel = active && isPlaying
    ? "暂停"
    : episode.progressSeconds > 0 && !episode.completed
      ? "继续收听"
      : "播放";
  const downloadProgressLabel = downloading
    ? podcastDownloadProgressLabel(episode)
    : null;
  return (
    <article className="podcast-detail">
      <section className="podcast-detail-hero">
        <PodcastArtwork
          url={
            episode.artworkUrl
            ?? episode.feedArtworkUrl
            ?? feed.artworkUrl
          }
          title={episode.title}
          large
        />
        <div className="podcast-detail-copy">
          <button type="button" onClick={onOpenShow}>{feed.title}</button>
          <h2>{episode.title}</h2>
          <div className="podcast-detail-meta">
            <span>{formatEpisodeFullDate(episode.publishedAt)}</span>
            <span>
              {episode.durationSeconds
                ? formatTime(episode.durationSeconds)
                : "时长未知"}
            </span>
            {episode.completed ? <span>已播放</span> : null}
            {queuePosition >= 0
              ? <span>待播第 {queuePosition + 1} 位</span>
              : null}
          </div>
          {episode.progressSeconds > 0 && !episode.completed ? (
            <div className="podcast-detail-progress">
              <span>
                已播放至 {formatTime(episode.progressSeconds)}
              </span>
              {episode.durationSeconds ? (
                <i>
                  <b
                    style={{
                      width: `${
                        Math.min(
                          100,
                          episode.progressSeconds
                            / episode.durationSeconds
                            * 100,
                        )
                      }%`,
                    }}
                  />
                </i>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <div className="podcast-detail-actions" aria-label="单集操作">
        <button
          type="button"
          className="primary"
          onClick={onPlay}
        >
          {active && isPlaying
            ? <Pause size={17} fill="currentColor" />
            : <Play size={17} fill="currentColor" />}
          {playLabel}
        </button>
        <button type="button" onClick={onPlayNext}>
          <SkipForward size={16} />
          下一集播放
        </button>
        <button type="button" onClick={onAddQueue}>
          <ListMusic size={16} />
          加入待播
        </button>
        <button
          type="button"
          onClick={onToggleSaved}
          disabled={Boolean(action)}
          className={episode.saved ? "active" : ""}
        >
          {action === "save"
            ? <MetroLoader size={16} />
            : <Bookmark size={16} fill={episode.saved ? "currentColor" : "none"} />}
          {episode.saved ? "移出稍后听" : "稍后听"}
        </button>
        {episode.localPath ? <span className="podcast-detail-downloaded">已下载</span> : (
          <button type="button" onClick={onDownload} disabled={downloading}>
            {downloading
              ? <MetroLoader size={16} />
              : <Download size={16} />}
            {downloading
              ? `正在下载${downloadProgressLabel ? ` ${downloadProgressLabel}` : ""}`
              : "下载"}
          </button>
        )}
        <details className="podcast-detail-more"><summary>更多操作</summary><div>        <Button variant="ghost" onClick={() => setAddingToList(true)}>加入播放列表</Button>
{episode.localPath ? (
          <button
            type="button"
            onClick={onDeleteDownload}
            disabled={Boolean(action)}
          >
            {action === "delete"
              ? <MetroLoader size={16} />
              : <Trash2 size={16} />}
            删除下载
          </button>
        ) : null}
        <button
          type="button"
          onClick={onTogglePlayed}
          disabled={Boolean(action)}
        >
          {action === "played"
            ? <MetroLoader size={16} />
            : episode.completed
              ? <RefreshCw size={16} />
              : <CheckCircle2 size={16} />}
          {episode.completed ? "标记为未播放" : "标记为已播放"}
        </button></div></details>
      </div>

      <div className="podcast-reading-nav" role="group" aria-label="单集内容">
        <Button variant="ghost" aria-pressed={reading === "notes"} onClick={() => setReading("notes")}>简介</Button>
        {detail.hasChapters && <Button variant="ghost" aria-pressed={reading === "chapters"} onClick={() => { setReading("chapters"); if (!chaptersOpen) onToggleChapters(); }}>章节</Button>}
        {<Button variant="ghost" aria-pressed={reading === "transcript"} onClick={() => setReading("transcript")}>转写</Button>}
        <Button variant="ghost" aria-pressed={reading === "bookmarks"} onClick={() => setReading("bookmarks")}>书签</Button>
      </div>
      <section className="podcast-detail-description" hidden={reading !== "notes"}>
        <h3>简介</h3>
        {episode.description?<PodcastNotes source={episode.description} base={episode.webpageUrl??feed.feedUrl} duration={episode.durationSeconds} onPlayAt={onPlayChapter}/>:<p>这集暂时没有简介。</p>}
      </section>
      {detail.hasChapters ? (
        <section className="podcast-detail-chapters" hidden={reading !== "chapters"}>
          <button
            type="button"
            className="podcast-chapter-disclosure"
            aria-expanded={chaptersOpen}
            aria-controls={chapterPanelId}
            onClick={onToggleChapters}
          >
            <span>
              <strong>章节</strong>
              <small>
                {chapterState === "ready" && chapterDocument
                  ? `${chapterDocument.chapters.length} 章`
                  : chapterState === "loading"
                    ? "正在读取"
                    : chapterState === "error"
                      ? "读取失败"
                      : "按需读取"}
              </small>
            </span>
            <ChevronDown size={18} aria-hidden="true" />
          </button>
          {chaptersOpen ? (
            <div id={chapterPanelId} className="podcast-chapter-panel">
              {chapterState === "loading" ? (
                <PodcastLoading label="正在读取章节" />
              ) : chapterState === "error" ? (
                <PodcastEmpty
                  label="暂时无法读取章节"
                  actionLabel="重试"
                  onAction={onRetryChapters}
                />
              ) : chapterDocument ? (
                <>
                  {chapterDocument.stale ? (
                    <p className="podcast-chapter-cache-note">
                      当前显示上次成功读取的章节
                    </p>
                  ) : null}
                  <ol className="podcast-chapter-list">
                    {chapterDocument.chapters.map((chapter, index) => {
                      const current = index === currentChapterIndex;
                      return (
                        <li key={`${chapter.startSeconds}-${chapter.title}`}>
                          <button
                            type="button"
                            className={current ? "current" : ""}
                            aria-current={current ? "true" : undefined}
                            aria-label={`跳到 ${chapter.title}，${formatTime(
                              chapter.startSeconds,
                            )}`}
                            onClick={() =>
                              onPlayChapter(chapter.startSeconds)}
                          >
                            <time>{formatTime(chapter.startSeconds)}</time>
                            <span>{chapter.title}</span>
                            {current ? <em>正在播放</em> : null}
                          </button>
                          {chapter.href&&<PodcastExternalLink href={chapter.href}>相关链接</PodcastExternalLink>}
                        </li>
                      );
                    })}
                  </ol>
                </>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
      {<div hidden={reading !== "transcript"}><TranscriptPanel key={`transcript-${episode.id}`} revealed={reading === "transcript"} episodeId={episode.id} active={active} progress={activeProgress} onPlayAt={onPlayChapter}/></div>}
      <div hidden={reading !== "bookmarks"}><EpisodeBookmarks key={`bookmarks-${episode.id}`} episode={episode} position={active ? activeProgress : episode.progressSeconds} onPlayAt={onPlayChapter}/></div>
      <Presence show={addingToList} exitDurationMs={MOTION_DURATIONS.micro}>
        <PlaylistPicker episode={episode} onClose={() => setAddingToList(false)} />
      </Presence>
    </article>
  );
}

export { EpisodeDetail };
