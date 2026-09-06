import { type MouseEvent as ReactMouseEvent } from "react";
import { Pause, Play } from "lucide-react";
import { formatTime } from "../../../utils/music";
import { podcastEpisodePlayedPercent } from "../../../utils/podcastListening";
import type { PodcastEpisode } from "../../../types";
import { podcastPlayedLabel } from "../format";
import { PodcastArtwork } from "./primitives";

function ContinueCard({
  episode,
  active,
  isPlaying,
  onOpen,
  onPlay,
  onContextMenu,
}: {
  episode: PodcastEpisode;
  active: boolean;
  isPlaying: boolean;
  onOpen: () => void;
  onPlay: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const percentage = podcastEpisodePlayedPercent(episode) ?? 0;
  const progressLabel = podcastPlayedLabel(episode);
  return (
    <article
      className={`podcast-continue-card${active ? " active" : ""}`}
      onContextMenu={onContextMenu}
    >
      <div className="podcast-continue-artwork">
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
      <button
        type="button"
        className="podcast-continue-open"
        onClick={onOpen}
        aria-label={`查看单集：${episode.title}，${progressLabel ?? "继续收听"}`}
      >
        <span>{episode.feedTitle || "播客"}</span>
        <strong>{episode.title}</strong>
        <span
          className="podcast-card-progress"
          aria-hidden="true"
        >
          <i style={{ width: `${percentage}%` }} />
        </span>
        <small>
          {episode.durationSeconds
            ? `共 ${formatTime(episode.durationSeconds)}`
            : "继续收听"}
        </small>
      </button>
      <button
        type="button"
        className="podcast-play-action"
        onClick={onPlay}
        title={active && isPlaying ? "暂停" : "继续收听"}
      >
        {active && isPlaying
          ? <Pause size={18} fill="currentColor" />
          : <Play size={18} fill="currentColor" />}
      </button>
    </article>
  );
}

export { ContinueCard };
