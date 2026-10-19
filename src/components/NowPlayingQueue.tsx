import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AudioLines } from "lucide-react";
import { useCollectionRows } from "../hooks/useCollectionRows";
import type { Track } from "../types";

// The queue CSS owns a 54px minimum row and 2px grid gap; measure actual rows on resize.
const ROW_GAP = 2;

export const NowPlayingQueue = memo(function NowPlayingQueue({ tracks, activeTrackId, onPlay }: {
  tracks: Track[];
  activeTrackId: string | null;
  onPlay: (track: Track) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const rows = useCollectionRows(scroller, tracks.length, tracks.length > 200, 56, 0, ".now-queue-track", ROW_GAP);
  useLayoutEffect(() => {
    if (!scroller.current?.contains(document.activeElement)) setFocusedIndex(null);
  }, [tracks]);
  useLayoutEffect(() => {
    if (!rows.virtual) return;
    const current = tracks.findIndex(track => track.id === activeTrackId);
    if (current >= 0) rows.scrollToIndex(current);
  }, [activeTrackId, tracks, rows.virtual]);
  const indices = Array.from({ length: rows.end - rows.start }, (_, index) => rows.start + index);
  // Keep a keyboard owner's real button alive when the mouse scrolls it out of view.
  if (focusedIndex !== null && focusedIndex < tracks.length && !indices.includes(focusedIndex)) {
    indices.push(focusedIndex);indices.sort((a, b) => a - b);
  }
  const content: ReactNode[] = [];
  const spacer = (start: number, count: number) => {
    if (count > 0) content.push(<div key={`space-${start}`} aria-hidden="true" style={{ height: count * rows.stride - ROW_GAP }} />);
  };
  let previous = 0;
  for (const index of indices) {
    spacer(previous, index - previous);
    const track = tracks[index];
    content.push(<div key={`${track.id}-${index}`} role="listitem" aria-posinset={index + 1} aria-setsize={tracks.length} style={{ minWidth: 0 }}>
      <button className={`now-queue-track${track.id === activeTrackId ? " now-panel-current" : ""}`}
      data-now-queue-index={index} data-collection-focus={`now-queue:${index}`}
      aria-current={track.id === activeTrackId ? "true" : undefined} onClick={() => onPlay(track)}>
      <div className="queue-row">
        <AudioLines size={16} aria-hidden="true" style={{ visibility: track.id === activeTrackId ? "visible" : "hidden" }} />
        <strong>{track.title}</strong>
      </div>
      <span>{track.artist}</span>
    </button></div>);
    previous = index + 1;
  }
  spacer(previous, tracks.length - previous);

  return <div ref={scroller} className="now-panel-tracks" onFocusCapture={event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-now-queue-index]");
    if (button) setFocusedIndex(Number(button.dataset.nowQueueIndex));
  }} onBlurCapture={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedIndex(null);
  }} onKeyDown={event => {
    if (!rows.virtual || event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-now-queue-index]");
    if (!button) return;
    const next = Number(button.dataset.nowQueueIndex) + (event.shiftKey ? -1 : 1);
    if (next < 0 || next >= tracks.length) return;
    // Preserve the original complete Tab order, including currently unmounted rows.
    event.preventDefault();rows.reveal(next, `now-queue:${next}`);
  }}>
    {tracks.length === 0 ? <div className="now-panel-empty"><strong>暂无播放</strong><span>请选择一首歌曲</span></div> : null}
    <div className="now-panel-upcoming" role="list" aria-label="正在播放列表">{content}</div>
  </div>;
});
