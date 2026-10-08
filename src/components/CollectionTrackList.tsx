import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Heart, Info, MoreHorizontal, Play } from "lucide-react";
import { formatTime } from "../utils/music";
import { albumReference, artistReference } from "../utils/collectionEntities";
import { CollectionLink, useCollectionContext } from "./CollectionContext";
import { usePinDrag } from "./tiles/usePinDrag";
import { Button } from "./Button";
import type { Track } from "../types";

/** Shared selection and playback behavior for every collection browser. */
export function CollectionTrackList({
  tracks, activeTrackId, onPlay, onContextMenu, favoriteTrackIds, onToggleFavorite,
  compact = false, label = "歌曲", emptyText = "暂无歌曲", listKey = label, playbackTracks,
  onReorder, scrollable = true,
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
  listKey?: string;
  playbackTracks?: Track[];
  onReorder?: (trackId: string, targetId: string) => void;
  scrollable?: boolean;
}) {
  const context = useCollectionContext();
  const [selectedId, setSelectedId] = useState<string | null>(() => context?.navigation.location.surface.selections[listKey] || null);
  const hasFavorite = Boolean(onToggleFavorite);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pendingDrag = useRef<{ id: string; row: HTMLElement; pointerId: number; x: number; y: number } | null>(null);
  const draggedId = useRef<string | null>(null), dropTarget = useRef<string | null>(null);
  const suppressClick = useRef(false);
  const touchTap = useRef<{ id: number; trackId: string; x: number; y: number; valid: boolean; released: boolean } | null>(null);
  const lastTouchPlayback = useRef<string | null>(null);
  const pointerDrag = usePinDrag(scrollerRef, {
    ghostClassName: "collection-track-drag-ghost",
    onStart: id => { draggedId.current = id; suppressClick.current = true; },
    onMove: (x, y) => {
      const area = scrollerRef.current;
      if (!area) return;
      const rect = area.getBoundingClientRect();
      const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      if (inside && y < rect.top + 24) area.scrollTop -= 12;
      if (inside && y > rect.bottom - 24) area.scrollTop += 12;
      const rows = [...area.querySelectorAll<HTMLElement>(".collection-track-row")];
      const target = inside ? rows.find(row => { const r = row.getBoundingClientRect(); return y >= r.top && y < r.bottom; }) : null;
      dropTarget.current = target?.dataset.collectionAnchor || null;
      rows.forEach(row => row.classList.toggle("is-drop-target", row === target && row.dataset.collectionAnchor !== draggedId.current));
    },
    onEnd: commit => {
      if (commit && draggedId.current && dropTarget.current) onReorder?.(draggedId.current, dropTarget.current);
      scrollerRef.current?.querySelectorAll(".is-drop-target").forEach(row => row.classList.remove("is-drop-target"));
      draggedId.current = null; dropTarget.current = null; pendingDrag.current = null;
    },
  });

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    touchTap.current = null;
    lastTouchPlayback.current = null;
    if (onReorder && event.altKey && !event.ctrlKey && !event.metaKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const target = tracks[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (target) onReorder(tracks[index].id, target.id);
      return;
    }
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
    <section className={`collection-track-list${compact ? " is-compact" : ""}${hasFavorite ? " has-favorite" : ""}${context ? " has-details" : ""}`} aria-label={label}
      data-collection-list={listKey} data-collection-selection={selectedId || undefined}>
      {!compact && (
        <div className="collection-track-head" aria-hidden="true">
          <span>#</span><span>歌曲</span><span>艺术家</span><span>专辑</span><span>时长</span><span />
        </div>
      )}
      <div ref={scrollerRef} className="collection-track-scroll" role="list" data-collection-scroll={scrollable ? `tracks:${listKey}` : undefined}
        onPointerMove={event => {
          const tap = touchTap.current;
          if (tap?.id === event.pointerId && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) >= 8) tap.valid = false;
          const pending = pendingDrag.current;
          if (pending && !draggedId.current && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) >= 8) {
            pointerDrag.begin(pending.id, pending.row, pending.pointerId, pending.x, pending.y);
          }
          pointerDrag.move(event);
        }}
        onPointerUp={event => {
          const tap = touchTap.current;
          if (tap?.id === event.pointerId) {
            tap.released = true;
            if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) >= 8) tap.valid = false;
          }
          pointerDrag.release(event); pendingDrag.current = null;
        }}
        onPointerCancel={() => { if (touchTap.current) touchTap.current.valid = false; pointerDrag.cancel(); pendingDrag.current = null; }}
        onLostPointerCapture={pointerDrag.cancel}>
        {tracks.length === 0 ? <p className="collection-empty">{emptyText}</p> : tracks.map((track, index) => {
          const playing = track.id === activeTrackId;
          const favorite = favoriteTrackIds?.has(track.id) ?? false;
          const duration = track.duration_seconds;
          const artist = context?.index.artistsByName.get(track.artist);
          const album = context?.index.albumByTrackId.get(track.id);
          return (
            <div key={track.id} role="listitem" data-collection-anchor={track.id}
              className={`collection-track-row${selectedId === track.id ? " selected" : ""}${playing ? " playing" : ""}`}
              onContextMenu={(event) => {
                if (touchTap.current) touchTap.current.valid = false;
                onContextMenu(event, track);
              }}>
              <button type="button" className="collection-track-main"
                aria-keyshortcuts={onReorder ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                onDragStart={event => event.preventDefault()}
                onPointerDown={event => {
                  suppressClick.current = false;
                  lastTouchPlayback.current = null;
                  touchTap.current = event.pointerType === "touch" && event.isPrimary && event.button === 0
                    ? { id: event.pointerId, trackId: track.id, x: event.clientX, y: event.clientY, valid: true, released: false } : null;
                  if (onReorder && event.button === 0 && event.pointerType !== "touch") pendingDrag.current = {
                    id: track.id, row: event.currentTarget.parentElement!, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
                  };
                }}
                data-collection-focus={`track:${listKey}:${track.id}`}
                aria-pressed={selectedId === track.id}
                aria-current={playing ? "true" : undefined}
                title={`${track.title} · ${track.artist} · ${track.album}`}
                onClick={(event) => {
                  if (suppressClick.current && event.detail > 0) { suppressClick.current = false; return; }
                  suppressClick.current = false;
                  const tap = touchTap.current;
                  touchTap.current = null;
                  if (tap && (!tap.valid || !tap.released || tap.trackId !== track.id)) return;
                  setSelectedId(track.id);
                  if (tap) {
                    lastTouchPlayback.current = track.id;
                    onPlay(track, playbackTracks || tracks);
                    return;
                  }
                  // Native keyboard/assistive activation emits a click with detail 0.
                  if (event.detail === 0) onPlay(track, playbackTracks || tracks);
                }}
                onDoubleClick={() => { if (lastTouchPlayback.current !== track.id) onPlay(track, playbackTracks || tracks); }}
                onKeyDown={(event) => navigate(event, index)}>
                <span className="collection-track-number" aria-label={playing ? "当前曲目" : undefined}>
                  {playing ? <Play size={11} fill="currentColor" /> : String(index + 1).padStart(2, "0")}
                </span>
                <strong>{track.title}</strong>
              </button>
              {!compact && <>
                <span className="collection-track-artist" title={track.artist}>{artist ? <CollectionLink entity={artistReference(artist)}
                  focusKey={`artist:${listKey}:${track.id}`}>{track.artist}</CollectionLink> : track.artist}</span>
                <span className="collection-track-album" title={track.album}>{album ? <CollectionLink entity={albumReference(album)}
                  focusKey={`album:${listKey}:${track.id}`}>{track.album}</CollectionLink> : track.album}</span>
              </>}
              <span className="collection-track-duration">{duration && Number.isFinite(duration) && duration > 0 ? formatTime(duration) : "—"}</span>
              <div className="collection-track-actions">{context && <button type="button" className="collection-track-info" aria-label={`查看歌曲 ${track.title}`}
                data-collection-focus={`info:${listKey}:${track.id}`} onClick={() => context.open({ kind: "track", id: track.id })}>
                <Info size={15} />
              </button>}
              {onToggleFavorite && <button type="button"
                className={`collection-track-favorite${favorite ? " active" : ""}`}
                aria-label={`${favorite ? "取消喜欢" : "喜欢"} ${track.title}`}
                aria-pressed={favorite}
                data-collection-focus={`favorite:${listKey}:${track.id}`}
                onClick={() => onToggleFavorite(track)}>
                <Heart size={15} fill={favorite ? "currentColor" : "none"} />
              </button>}
              <Button variant="ghost" className="collection-track-more" aria-label={`更多操作：${track.title}`}
                title="更多操作" aria-haspopup="menu" data-collection-focus={`more:${listKey}:${track.id}`}
                onClick={event => { touchTap.current = null; onContextMenu(event, track); }}>
                <MoreHorizontal size={17} aria-hidden="true" />
              </Button></div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
