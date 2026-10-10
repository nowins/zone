import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Play,
  X,
} from "lucide-react";
import { formatTime } from "../../../utils/music";
import type { PodcastQueueItem } from "../../../types";
import type { PodcastQueueDropPlacement } from "../types";
import { formatFileSize } from "../format";

function QueueEpisodeRow({
  item,
  index,
  count,
  selecting,
  selected,
  dragging,
  dropPlacement,
  onSelect,
  onOpen,
  onPlay,
  onMove,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onContextMenu,
}: {
  item: PodcastQueueItem;
  index: number;
  count: number;
  selecting: boolean;
  selected: boolean;
  dragging: boolean;
  dropPlacement?: PodcastQueueDropPlacement;
  onSelect: () => void;
  onOpen: () => void;
  onPlay: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onDragStart: (event: ReactDragEvent<HTMLSpanElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const fileBytes = item.episode.localPath
    ? item.episode.downloadedBytes
    : item.episode.totalBytes;

  return (
    <article
      className={[
        "podcast-queue-episode",
        selecting ? "selecting" : "",
        selected ? "selected" : "",
        dragging ? "is-dragging" : "",
        dropPlacement ? "is-drop-target" : "",
      ].filter(Boolean).join(" ")}
      data-podcast-episode={item.episode.id}
      data-drop-position={dropPlacement}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-touch-menu onContextMenu={onContextMenu}
    >
      {selecting ? (
        <button
          type="button"
          className="podcast-queue-select-control"
          aria-label={`${selected ? "取消选择" : "选择"}“${
            item.episode.title
          }”`}
          aria-pressed={selected}
          onClick={onSelect}
        >
          {selected ? <Check size={15} aria-hidden="true" /> : null}
        </button>
      ) : (
        <span
          className="podcast-queue-drag"
          draggable={count > 1}
          aria-hidden="true"
          data-disabled={count < 2}
          title="拖动排序"
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <GripVertical size={16} aria-hidden="true" />
        </span>
      )}
      <span className="podcast-queue-position">
        {String(index + 1).padStart(2, "0")}
      </span>
      <button
        type="button"
        className="podcast-queue-copy"
        aria-pressed={selecting ? selected : undefined}
        onClick={selecting ? onSelect : onOpen}
      >
        <strong>{item.episode.title}</strong>
        <small>
          {item.episode.feedTitle || "播客"}
          {item.episode.durationSeconds
            ? ` · ${formatTime(item.episode.durationSeconds)}`
            : ""}
          {typeof fileBytes === "number" && fileBytes > 0
            ? ` · ${formatFileSize(fileBytes)}`
            : ""}
        </small>
      </button>
      {!selecting ? (
        <div className="podcast-queue-actions">
          <button type="button" onClick={onPlay} title="立即播放" aria-label={`播放“${item.episode.title}”`}>
            <Play size={15} fill="currentColor" />
          </button>
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            title="上移" aria-label={`将第 ${index+1} 集“${item.episode.title}”上移`}
          >
            <ChevronUp size={16} />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={index === count - 1}
            title="下移" aria-label={`将第 ${index+1} 集“${item.episode.title}”下移`}
          >
            <ChevronDown size={16} />
          </button>
          <button type="button" onClick={onRemove} title="从待播队列移除" aria-label={`从待播移除“${item.episode.title}”`}>
            <X size={16} />
          </button>
        </div>
      ) : null}
    </article>
  );
}

export { QueueEpisodeRow };
