import { Info, Play } from "lucide-react";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { tiltPressClear, tiltPressDown } from "../utils/tiltPress";
import type { KeyboardEvent, MouseEvent } from "react";

export function CollectionAlbumTile({ name, artist, coverPath, index, selected, className = "album-tile", onSelect, onPlay, onContextMenu, focusKey,
  onDetails, tabIndex, choiceKey, onKeyDown }: {
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
  onDetails?: () => void;
  tabIndex?: number;
  choiceKey?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className={`${className} collection-album-tile${selected ? " selected" : ""}`} data-touch-menu onContextMenu={onContextMenu}>
      <button type="button" className="collection-album-select" aria-pressed={selected} data-collection-focus={focusKey}
        title={`${name} · ${artist}`} onClick={onSelect} tabIndex={tabIndex} data-browse-choice={choiceKey} onKeyDown={onKeyDown}
        onPointerDown={tiltPressDown} onPointerUp={tiltPressClear}
        onPointerLeave={tiltPressClear} onPointerCancel={tiltPressClear}>
        <Cover artPath={coverPath} label={name} size="large" index={index} />
        <strong>{name}</strong><span>{artist}</span>
      </button>
      <button type="button" className="album-play" title={`播放 ${name}`} onClick={onPlay} tabIndex={tabIndex}>
        <Play size={18} fill="currentColor" />
      </button>
      {onDetails && <Button variant="ghost" size="sm" className="collection-album-info" aria-label={`查看专辑 ${name}`}
        data-collection-focus={focusKey ? focusKey + ":details" : undefined} tabIndex={tabIndex} onClick={onDetails}><Info size={15} /></Button>}
    </div>
  );
}
