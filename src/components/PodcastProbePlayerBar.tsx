import { Pause, Play, Podcast, RotateCcw, RotateCw } from "lucide-react";
import { PlaybackProgress } from "./PlaybackProgress";
import { VolumeControl } from "./TransportControls";
import type { PodcastProbePlayback } from "../types";

export function PodcastProbePlayerBar({
  episode,
  isPlaying,
  progress,
  duration,
  volume,
  onPlayPause,
  onSeek,
  onVolume,
  onOpenPodcasts,
}: {
  episode: PodcastProbePlayback;
  isPlaying: boolean;
  progress: number;
  duration: number;
  volume: number;
  onPlayPause: () => void;
  onSeek: (value: number) => void;
  onVolume: (value: number) => void;
  onOpenPodcasts: () => void;
}) {
  return (
    <footer className="player podcast-player">
      <nav className="player-shortcuts" aria-label="播客快捷方式">
        <button onClick={onOpenPodcasts} title="返回播客">
          <Podcast size={19} />
        </button>
      </nav>

      <div className="player-primary">
        <button className="player-cover podcast-player-cover" onClick={onOpenPodcasts} title="返回播客">
          {episode.artworkUrl ? (
            <img src={episode.artworkUrl} alt="" draggable={false} referrerPolicy="no-referrer" />
          ) : (
            <span aria-hidden="true"><Podcast size={22} /></span>
          )}
        </button>
        <PlaybackProgress
          label={`${episode.title} · ${episode.podcastTitle}`}
          progress={progress}
          duration={duration}
          onLabelClick={onOpenPodcasts}
          onSeek={onSeek}
        />
      </div>

      <div className="player-transport">
        <div className="zune-controls podcast-controls">
          <button onClick={() => onSeek(Math.max(0, progress - 15))} title="后退 15 秒">
            <RotateCcw size={16} />
            <span>15</span>
          </button>
          <button className="zune-play" onClick={onPlayPause} title={isPlaying ? "暂停" : "播放"}>
            {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </button>
          <button onClick={() => onSeek(Math.min(duration || progress + 30, progress + 30))} title="前进 30 秒">
            <RotateCw size={16} />
            <span>30</span>
          </button>
        </div>
        <VolumeControl volume={volume} onVolume={onVolume} />
      </div>
    </footer>
  );
}
