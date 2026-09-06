import { type MouseEvent as ReactMouseEvent } from "react";
import {
  Check,
  Download,
  Pause,
  Play,
} from "lucide-react";
import { MetroLoader } from "../../../components/MetroLoader";
import { formatTime } from "../../../utils/music";
import type { PodcastEpisode } from "../../../types";
import {
  formatEpisodeDate,
  formatFileSize,
  plainText,
  podcastDownloadProgressLabel,
  podcastPlayedLabel,
} from "../format";
import { PodcastArtwork } from "./primitives";

function EpisodeRow({
  episode,
  active,
  isPlaying,
  downloading,
  showFeed = false,
  showArtwork = false,
  showDownloadedSize = false,
  selecting = false,
  selected = false,
  isNew = false,
  onOpen,
  onSelect,
  onPlay,
  onDownload,
  onContextMenu,
}: {
  episode: PodcastEpisode;
  active: boolean;
  isPlaying: boolean;
  downloading: boolean;
  showFeed?: boolean;
  showArtwork?: boolean;
  showDownloadedSize?: boolean;
  selecting?: boolean;
  selected?: boolean;
  isNew?: boolean;
  onOpen: () => void;
  onSelect?: () => void;
  onPlay: () => void;
  onDownload: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const progressLabel = podcastPlayedLabel(episode);
  const downloadProgressLabel = downloading
    ? podcastDownloadProgressLabel(episode)
    : null;
  const accessibilityLabel = [
    selecting
      ? `${selected ? "取消选择" : "选择"}单集：${episode.title}`
      : `查看单集：${episode.title}`,
    isNew ? "24 小时内更新" : null,
    progressLabel,
  ].filter(Boolean).join("，");
  return (
    <article
      className={`podcast-episode${showArtwork ? " with-artwork" : ""}${
        active ? " active" : ""
      }${selecting ? " selecting" : ""}${selected ? " selected" : ""
      }`}
      onContextMenu={onContextMenu}
    >
      {showArtwork ? (
        <div className="podcast-episode-artwork">
          <PodcastArtwork
            url={episode.artworkUrl ?? episode.feedArtworkUrl}
            title={episode.feedTitle ?? episode.title}
          />
          {progressLabel ? (
            <span className="podcast-cover-progress" aria-hidden="true">
              {progressLabel}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="podcast-episode-date">
          <span>{formatEpisodeDate(episode.publishedAt)}</span>
          <small>
            {[
              episode.durationSeconds
                ? formatTime(episode.durationSeconds)
                : "时长未知",
              showDownloadedSize && episode.downloadedBytes > 0
                ? formatFileSize(episode.downloadedBytes)
                : null,
            ].filter(Boolean).join(" · ")}
          </small>
        </div>
      )}
      <button
        type="button"
        className="podcast-episode-copy podcast-episode-open"
        onClick={selecting && onSelect ? onSelect : onOpen}
        aria-label={accessibilityLabel}
      >
        {showArtwork ? (
          <span className="podcast-episode-meta">
            {showFeed && episode.feedTitle ? (
              <span className="podcast-episode-feed">{episode.feedTitle}</span>
            ) : null}
            {isNew ? <em className="podcast-new-badge">新</em> : null}
            <span>{formatEpisodeDate(episode.publishedAt)}</span>
            <span>
              {episode.durationSeconds
                ? formatTime(episode.durationSeconds)
                : "时长未知"}
            </span>
          </span>
        ) : showFeed && episode.feedTitle ? (
          <span className="podcast-episode-feed">{episode.feedTitle}</span>
        ) : null}
        <strong>{episode.title}</strong>
        {episode.description ? <p>{plainText(episode.description)}</p> : null}
        {!showArtwork && (episode.progressSeconds > 0 || episode.completed) ? (
          <small>
            {episode.completed
              ? "已播放"
              : `已播放至 ${formatTime(episode.progressSeconds)}`}
          </small>
        ) : null}
      </button>
      <div className="podcast-episode-actions">
        {selecting && onSelect ? (
          <button
            type="button"
            className="podcast-episode-select"
            aria-pressed={selected}
            aria-label={`${selected ? "取消选择" : "选择"}“${episode.title}”`}
            onClick={onSelect}
          >
            {selected ? <Check size={17} /> : null}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="podcast-download-action"
              onClick={onDownload}
              disabled={downloading || Boolean(episode.localPath)}
              title={
                episode.localPath
                  ? "已下载，可离线收听"
                  : downloading
                    ? downloadProgressLabel
                    ? `正在下载 ${downloadProgressLabel}`
                    : "正在下载"
                    : "下载以便离线收听"
              }
            >
              {downloading && downloadProgressLabel ? (
                <span className="podcast-download-progress">
                  {downloadProgressLabel}
                </span>
              ) : downloading ? (
                <MetroLoader size={16} />
              ) : episode.localPath ? (
                <Check size={16} />
              ) : (
                <Download size={16} />
              )}
            </button>
            <button
              type="button"
              className="podcast-play-action"
              onClick={onPlay}
              title={
                active && isPlaying
                  ? "暂停"
                  : episode.progressSeconds > 0
                    ? "继续收听"
                    : "播放"
              }
            >
              {active && isPlaying
                ? <Pause size={17} fill="currentColor" />
                : <Play size={17} fill="currentColor" />}
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function CurrentEpisodeRow({
  episode,
  isPlaying,
  onOpen,
  onPlay,
  onContextMenu,
}: {
  episode: PodcastEpisode;
  isPlaying: boolean;
  onOpen: () => void;
  onPlay: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  return (
    <article
      className="podcast-current-episode"
      onContextMenu={onContextMenu}
    >
      <PodcastArtwork
        url={episode.artworkUrl ?? episode.feedArtworkUrl}
        title={episode.feedTitle ?? episode.title}
      />
      <button
        type="button"
        className="podcast-current-copy"
        onClick={onOpen}
      >
        <span>{episode.feedTitle || "播客"}</span>
        <strong>{episode.title}</strong>
        <small>
          {episode.completed
            ? "已播放"
            : episode.progressSeconds > 0
              ? `已播放至 ${formatTime(episode.progressSeconds)}`
              : "正在播放"}
        </small>
      </button>
      <button
        type="button"
        className="podcast-play-action"
        onClick={onPlay}
        title={isPlaying ? "暂停" : "继续收听"}
      >
        {isPlaying
          ? <Pause size={18} fill="currentColor" />
          : <Play size={18} fill="currentColor" />}
      </button>
    </article>
  );
}

export { CurrentEpisodeRow, EpisodeRow };
