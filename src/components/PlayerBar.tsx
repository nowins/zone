import type { CSSProperties } from "react";
import {
  Disc3,
  Heart,
  LibraryBig,
  ListMusic,
  Pause,
  Play,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";
import { Cover } from "./Cover";
import { formatTime } from "../utils/music";
import type { RepeatMode, Track, ViewMode } from "../types";

export function PlayerBar({
  track,
  isPlaying,
  progress,
  duration,
  volume,
  shuffle,
  repeat,
  isFavorite,
  onPlayPause,
  onPrevious,
  onNext,
  onSeek,
  onVolume,
  onShuffle,
  onRepeat,
  onToggleFavorite,
  onOpenNowPlaying,
  onNavigateCollection,
}: {
  track: Track | null;
  isPlaying: boolean;
  progress: number;
  duration: number;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  isFavorite: boolean;
  onPlayPause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeek: (value: number) => void;
  onVolume: (value: number) => void;
  onShuffle: () => void;
  onRepeat: () => void;
  onToggleFavorite: () => void;
  onOpenNowPlaying: () => void;
  onNavigateCollection: (view: ViewMode) => void;
}) {
  const remaining = Math.max(0, duration - progress);
  const progressPercent = duration > 0 ? Math.min(100, (progress / duration) * 100) : 0;

  return (
    <footer className="player">
      <nav className="player-shortcuts" aria-label="收藏快捷方式">
        <button onClick={() => onNavigateCollection("albums")} title="专辑">
          <LibraryBig size={18} />
        </button>
        <button onClick={() => onNavigateCollection("artists")} title="艺术家">
          <Disc3 size={20} />
        </button>
        <button onClick={() => onNavigateCollection("playlists")} title="播放列表">
          <ListMusic size={19} />
        </button>
      </nav>

      <div className="player-track">
        <button className="now" onClick={onOpenNowPlaying} disabled={!track} title="打开正在播放">
          <Cover artPath={track?.cover_path} label={track?.album ?? ""} size="mini" />
          <span className="now-copy">
            <strong>{track?.title ?? "nothing playing"}</strong>
            <span>{track ? `${track.artist} · ${track.album}` : "add a folder and choose a song"}</span>
          </span>
        </button>

        <button
          className={`player-favorite ${isFavorite ? "active" : ""}`}
          onClick={onToggleFavorite}
          disabled={!track}
          title={isFavorite ? "取消收藏" : "收藏"}
        >
          <Heart size={14} fill={isFavorite ? "currentColor" : "none"} />
        </button>

        <div className="scrub">
          <span>{formatTime(progress)}</span>
          <input
            type="range"
            min={0}
            max={Number.isFinite(duration) ? duration : 0}
            value={Math.min(progress, duration || 0)}
            onChange={(event) => onSeek(Number(event.target.value))}
            disabled={!track}
            aria-label="播放进度"
            style={{ "--range-progress": `${progressPercent}%` } as CSSProperties}
          />
          <span>{duration ? `-${formatTime(remaining)}` : "0:00"}</span>
        </div>
      </div>

      <div className="transport">
        <div className="buttons">
          <button className={repeat !== "off" ? "active" : ""} onClick={onRepeat} title={`循环 ${repeat}`}>
            <Repeat size={14} />
          </button>
          <button className={shuffle ? "active" : ""} onClick={onShuffle} title="随机播放">
            <Shuffle size={14} />
          </button>
          <button onClick={onPrevious} title="上一首" disabled={!track}>
            <SkipBack size={16} />
          </button>
          <button className="play-button" onClick={onPlayPause} title={isPlaying ? "暂停" : "播放"} disabled={!track}>
            {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </button>
          <button onClick={onNext} title="下一首" disabled={!track}>
            <SkipForward size={16} />
          </button>
        </div>
        <label className="volume">
          <Volume2 size={15} />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(event) => onVolume(Number(event.target.value))}
            aria-label="音量"
            style={{ "--range-progress": `${volume * 100}%` } as CSSProperties}
          />
        </label>
      </div>
    </footer>
  );
}
