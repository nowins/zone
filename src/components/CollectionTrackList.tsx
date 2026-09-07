import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { Heart, Play } from "lucide-react";
import { formatTime } from "../utils/music";
import type { Track } from "../types";

/** Shared selection and playback behavior for every collection browser. */
export function CollectionTrackList({
  tracks, activeTrackId, onPlay, onContextMenu, favoriteTrackIds, onToggleFavorite,
  compact = false, label = "歌曲", emptyText = "暂无歌曲",
}: {
  tracks: Track[];
  activeTrackId: string | null;
  onPlay: (track: Track, sourceTracks?: Track[]) => void;
  onContextMenu: (event: MouseEvent, track: Track) => void;
  favoriteTrackIds?: ReadonlySet<string>;
  onToggleFavorite?: (track: Track) => void;
  compact?: boolean;
  label?: string;
  emptyText?: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const hasFavorite = Boolean(onToggleFavorite);

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const next = event.key === "ArrowDown" ? Math.min(index + 1, tracks.length - 1)
      : event.key === "ArrowUp" ? Math.max(index - 1, 0)
      : event.key === "Home" ? 0
      : event.key === "End" ? tracks.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const buttons = event.currentTarget.closest(".collection-track-scroll")
      ?.querySelectorAll<HTMLButtonElement>(".collection-track-main");
    setSelectedId(tracks[next].id);
    buttons?.[next]?.focus({ preventScroll: true });
    buttons?.[next]?.scrollIntoView({ block: "nearest" });
  }

  return (
    <section className={`collection-track-list${compact ? " is-compact" : ""}${hasFavorite ? " has-favorite" : ""}`} aria-label={label}>
      {!compact && (
        <div className="collection-track-head" aria-hidden="true">
          <span>#</span><span>歌曲</span><span>艺术家</span><span>专辑</span><span>时长</span>
        </div>
      )}
      <div className="collection-track-scroll" role="list">
        {tracks.length === 0 ? <p className="collection-empty">{emptyText}</p> : tracks.map((track, index) => {
          const playing = track.id === activeTrackId;
          const favorite = favoriteTrackIds?.has(track.id) ?? false;
          const duration = track.duration_seconds;
          return (
            <div key={track.id} role="listitem"
              className={`collection-track-row${selectedId === track.id ? " selected" : ""}${playing ? " playing" : ""}`}
              onContextMenu={(event) => onContextMenu(event, track)}>
              <button type="button" className="collection-track-main"
                aria-pressed={selectedId === track.id}
                aria-current={playing ? "true" : undefined}
                title={`${track.title} · ${track.artist} · ${track.album}`}
                onClick={(event) => {
                  setSelectedId(track.id);
                  // Native keyboard/assistive activation emits a click with detail 0.
                  if (event.detail === 0) onPlay(track, tracks);
                }}
                onDoubleClick={() => onPlay(track, tracks)}
                onKeyDown={(event) => navigate(event, index)}>
                <span className="collection-track-number" aria-label={playing ? "当前曲目" : undefined}>
                  {playing ? <Play size={11} fill="currentColor" /> : String(index + 1).padStart(2, "0")}
                </span>
                <strong>{track.title}</strong>
                {!compact && <><em>{track.artist}</em><small>{track.album}</small></>}
                <span className="collection-track-duration">{duration && Number.isFinite(duration) && duration > 0 ? formatTime(duration) : "—"}</span>
              </button>
              {onToggleFavorite && <button type="button"
                className={`collection-track-favorite${favorite ? " active" : ""}`}
                aria-label={`${favorite ? "取消收藏" : "收藏"} ${track.title}`}
                aria-pressed={favorite}
                onClick={() => onToggleFavorite(track)}>
                <Heart size={15} fill={favorite ? "currentColor" : "none"} />
              </button>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
