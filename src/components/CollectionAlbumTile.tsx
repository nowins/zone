import { Play } from "lucide-react";
import { Cover } from "./Cover";
import { tiltPressClear, tiltPressDown } from "../utils/tiltPress";
import type { MouseEvent } from "react";

export function CollectionAlbumTile({ name, artist, coverPath, index, selected, className = "album-tile", onSelect, onPlay, onContextMenu, focusKey }: {
  name: string;
  artist: string;
  coverPath?: string | null;
  index: number;
  selected?: boolean;
  className?: string;
  onSelect: () => void;
  onPlay: () => void;
  onContextMenu: (event: MouseEvent) => void;
  focusKey?: string;
}) {
  return (
    <div className={`${className} collection-album-tile${selected ? " selected" : ""}`} onContextMenu={onContextMenu}>
      <button type="button" className="collection-album-select" aria-pressed={selected} data-collection-focus={focusKey}
        title={`${name} · ${artist}`} onClick={onSelect}
        onPointerDown={tiltPressDown} onPointerUp={tiltPressClear}
        onPointerLeave={tiltPressClear} onPointerCancel={tiltPressClear}>
        <Cover artPath={coverPath} label={name} size="large" index={index} />
        <strong>{name}</strong><span>{artist}</span>
      </button>
      <button type="button" className="album-play" title={`播放 ${name}`} onClick={onPlay}>
        <Play size={18} fill="currentColor" />
      </button>
    </div>
  );
}
