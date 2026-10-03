import { Pause, Play, Podcast, RotateCcw, RotateCw } from "lucide-react";
import { PlaybackProgress } from "./PlaybackProgress";
import { VolumeControl } from "./TransportControls";
import type { PodcastPlayback, PodcastPlaybackStatus } from "../types";
import { podcastArtworkSrc } from "../utils/podcastArtwork";

export function PodcastPlayerBar({
  episode,
  isPlaying,
  progress,
  duration,
  volume,
  status,
  onPlayPause,
  onRetry,
  onSeek,
  onVolume,
  onOpenPodcasts,
  onOpenNowPlaying,
  backwardSeconds = 15,
  forwardSeconds = 30,
}: {
  episode: PodcastPlayback;
  isPlaying: boolean;
  progress: number;
  duration: number;
  volume: number;
  status: PodcastPlaybackStatus;
  onPlayPause: () => void;
  onRetry: () => void;
  onSeek: (value: number) => void;
  onVolume: (value: number) => void;
  onOpenPodcasts: () => void;
  onOpenNowPlaying: () => void;
  backwardSeconds?: number;
  forwardSeconds?: number;
}) {
  const artworkSrc = podcastArtworkSrc(episode.artworkUrl);
  return (
    <footer className="player podcast-player">
      <nav className="player-shortcuts" aria-label="播客快捷方式">
        <button onClick={onOpenPodcasts} title="返回播客">
          <Podcast size={19} />
        </button>
      </nav>

      <div className="player-primary">
        <button className="player-cover podcast-player-cover" onClick={onOpenNowPlaying} title="打开正在播放">
          {artworkSrc ? (
            <img src={artworkSrc} alt="" draggable={false} />
          ) : (
            <span aria-hidden="true"><Podcast size={22} /></span>
          )}
        </button>
        <PlaybackProgress
          label={`${episode.title} · ${episode.podcastTitle}`}
          progress={progress}
          duration={duration}
          onLabelClick={onOpenNowPlaying}
          onSeek={onSeek}
        />
      </div>

      <div className="player-transport">
        <div className="zune-controls podcast-controls">
          <button onClick={() => onSeek(Math.max(0, progress - backwardSeconds))} title={`后退 ${backwardSeconds} 秒`} aria-label={`后退 ${backwardSeconds} 秒`}>
            <RotateCcw size={16} />
            <span>{backwardSeconds}</span>
          </button>
          <button
            className="zune-play"
            onClick={status === "error" ? onRetry : onPlayPause}
            title={status === "error" ? "重试播放" : isPlaying ? "暂停" : "播放"}
          >
            {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </button>
          <button onClick={() => onSeek(Math.min(duration || progress + forwardSeconds, progress + forwardSeconds))} title={`前进 ${forwardSeconds} 秒`} aria-label={`前进 ${forwardSeconds} 秒`}>
            <RotateCw size={16} />
            <span>{forwardSeconds}</span>
          </button>
        </div>
        <VolumeControl volume={volume} onVolume={onVolume} />
      </div>
    </footer>
  );
}
