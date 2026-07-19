import type { CSSProperties } from "react";
import { Heart } from "lucide-react";
import { formatTime } from "../utils/music";

export function PlaybackProgress({
  label,
  progress,
  duration,
  disabled = false,
  isFavorite,
  onLabelClick,
  onSeek,
  onToggleFavorite,
}: {
  label: string;
  progress: number;
  duration: number;
  disabled?: boolean;
  isFavorite?: boolean;
  onLabelClick?: () => void;
  onSeek: (value: number) => void;
  onToggleFavorite?: () => void;
}) {
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const safeProgress = Math.min(Math.max(0, progress), safeDuration);
  const progressPercent = safeDuration > 0 ? (safeProgress / safeDuration) * 100 : 0;
  const remaining = Math.max(0, safeDuration - safeProgress);

  return (
    <div className="zune-progress">
      <div className="zune-progress-heading">
        {onLabelClick ? (
          <button onClick={onLabelClick} disabled={disabled} title="打开正在播放">
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
        onChange={(event) => onSeek(Number(event.target.value))}
        disabled={disabled}
        aria-label="播放进度"
        style={{ "--range-progress": `${progressPercent}%` } as CSSProperties}
      />
      <span className="zune-progress-time zune-progress-time-end">
        {safeDuration > 0 ? `-${formatTime(remaining)}` : "0:00"}
      </span>
    </div>
  );
}
