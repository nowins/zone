import { Pause, Play, Repeat, Shuffle, SkipBack, SkipForward, Square } from "lucide-react";
import { Cover } from "./Cover";
import { formatTime } from "../utils/music";
import type { RepeatMode, Track } from "../types";

export function PlayerBar({
  track,
  isPlaying,
  progress,
  duration,
  volume,
  shuffle,
  repeat,
  onPlayPause,
  onPrevious,
  onNext,
  onSeek,
  onVolume,
  onShuffle,
  onRepeat,
  onOpenNowPlaying,
}: {
  track: Track | null;
  isPlaying: boolean;
  progress: number;
  duration: number;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  onPlayPause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeek: (value: number) => void;
  onVolume: (value: number) => void;
  onShuffle: () => void;
  onRepeat: () => void;
  onOpenNowPlaying: () => void;
}) {
  return (
    <footer className="player">
      <button className="now" onClick={onOpenNowPlaying} disabled={!track} title="Open now playing">
        <Cover artPath={track?.cover_path} label={track?.album ?? ""} size="mini" />
        <div>
          <strong>{track?.title ?? "nothing playing"}</strong>
          <span>{track ? `${track.artist} / ${track.album}` : "add a folder and choose a song"}</span>
        </div>
      </button>

      <div className="transport">
        <div className="buttons">
          <button className={shuffle ? "active" : ""} onClick={onShuffle} title="Shuffle">
            <Shuffle size={18} />
          </button>
          <button onClick={onPrevious} title="Previous" disabled={!track}>
            <SkipBack size={21} />
          </button>
          <button className="play-button" onClick={onPlayPause} title={isPlaying ? "Pause" : "Play"} disabled={!track}>
            {isPlaying ? <Pause size={25} /> : <Play size={25} />}
          </button>
          <button onClick={onNext} title="Next" disabled={!track}>
            <SkipForward size={21} />
          </button>
          <button className={repeat !== "off" ? "active" : ""} onClick={onRepeat} title={`Repeat ${repeat}`}>
            <Repeat size={18} />
          </button>
        </div>
        <div className="scrub">
          <span>{formatTime(progress)}</span>
          <input
            type="range"
            min={0}
            max={Number.isFinite(duration) ? duration : 0}
            value={Math.min(progress, duration || 0)}
            onChange={(event) => onSeek(Number(event.target.value))}
            disabled={!track}
          />
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <div className="volume">
        <Square size={11} />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(event) => onVolume(Number(event.target.value))}
        />
      </div>
    </footer>
  );
}
