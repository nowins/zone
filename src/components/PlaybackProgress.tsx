import type { CSSProperties } from "react";
import { Heart } from "lucide-react";
import { formatTime } from "../utils/music";
import { usePlaybackScrub } from "../hooks/usePlaybackScrub";

export function PlaybackProgress({
  label,
  progress,
  duration,
  mediaKey,
  disabled = false,
  isFavorite,
  onLabelClick,
  onSeek,
  onToggleFavorite,
}: {
  label: string;
  progress: number;
  duration: number;
  mediaKey?: string;
  disabled?: boolean;
  isFavorite?: boolean;
  onLabelClick?: () => void;
  onSeek: (value: number) => void;
  onToggleFavorite?: () => void;
}) {
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const playbackProgress = Number.isFinite(progress) ? Math.min(Math.max(0, progress), safeDuration) : 0;
  const { value: safeProgress, inputProps } = usePlaybackScrub({
    progress: playbackProgress, duration: safeDuration, disabled, mediaKey, onSeek,
  });
  const progressPercent = safeDuration > 0 ? (safeProgress / safeDuration) * 100 : 0;
  const remaining = Math.max(0, safeDuration - safeProgress);

  return (
    <div className="zune-progress">
      <div className="zune-progress-heading">
        {onLabelClick ? (
          <button data-now-playing-trigger="title" onClick={onLabelClick} disabled={disabled} title="打开正在播放">
            {label}
          </button>
        ) : (
          <span>{label}</span>
        )}
        {onToggleFavorite ? (
          <button
            className={`zune-progress-favorite ${isFavorite ? "active" : ""}`}
            onClick={onToggleFavorite}
            disabled={disabled}
            title={isFavorite ? "取消收藏" : "收藏"}
          >
            <Heart size={12} fill={isFavorite ? "currentColor" : "none"} />
          </button>
        ) : null}
      </div>
      <span className="zune-progress-time zune-progress-time-start">{formatTime(safeProgress)}</span>
      <input
        type="range"
        min={0}
        max={safeDuration}
        value={safeProgress}
        {...inputProps}
        disabled={disabled}
        aria-label="播放进度"
        aria-valuetext={formatTime(safeProgress)}
        style={{ "--range-progress": `${progressPercent}%` } as CSSProperties}
      />
      <span className="zune-progress-time zune-progress-time-end">
        {safeDuration > 0 ? `-${formatTime(remaining)}` : "0:00"}
      </span>
    </div>
  );
}
