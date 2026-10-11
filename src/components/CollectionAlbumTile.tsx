import { Info, Play } from "lucide-react";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { useCollectionContext } from "./CollectionContext";
import { tiltPressClear, tiltPressDown } from "../utils/tiltPress";
import { useState, type KeyboardEvent, type MouseEvent } from "react";

export function CollectionAlbumTile({ name, artist, coverPath, index, selected, className = "album-tile", onSelect, onPlay, onContextMenu, focusKey,
  onDetails, tabIndex, choiceKey, onKeyDown, subtitle }: {
  name: string;
  artist: string;
  subtitle?: string;
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
  const restoredFocus = useCollectionContext()?.navigation.location.surface.focus;
  // Reveal the source action before navigation attempts to focus it on return.
  const [keyboardFocus, setKeyboardFocus] = useState(() => Boolean(focusKey && restoredFocus === focusKey + ":details"));
  return (
    <div className={`${className} collection-album-tile${selected ? " selected" : ""}`} data-touch-menu onContextMenu={onContextMenu}
      data-keyboard-focus={keyboardFocus || undefined}
      onFocusCapture={event => { if (event.target.matches(":focus-visible")) setKeyboardFocus(true); }}
      onKeyDownCapture={() => setKeyboardFocus(true)}
      onPointerDownCapture={event => {
        if (event.target instanceof Element && event.target.closest(".collection-album-select")) setKeyboardFocus(false);
      }}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setKeyboardFocus(false); }}>
      <button type="button" className="collection-album-select" aria-pressed={selected} data-collection-focus={focusKey}
        aria-label={`${name} · ${artist}`} onClick={onSelect} tabIndex={tabIndex} data-browse-choice={choiceKey} onKeyDown={onKeyDown}
        onPointerDown={tiltPressDown} onPointerUp={tiltPressClear}
        onPointerLeave={tiltPressClear} onPointerCancel={tiltPressClear}>
        <Cover artPath={coverPath} label={name} size="large" index={index} />
        <strong title={name}>{name}</strong><span title={subtitle ?? artist}>{subtitle ?? artist}</span>
      </button>
      <Button variant="ghost" size="sm" className="album-play" aria-label={`播放 ${name}`} onClick={onPlay} tabIndex={tabIndex}>
        <Play size={16} fill="currentColor" />
      </Button>
      {onDetails && <Button variant="ghost" size="sm" className="collection-album-info" aria-label={`查看专辑 ${name}`}
        data-collection-focus={focusKey ? focusKey + ":details" : undefined} tabIndex={tabIndex} onClick={onDetails}><Info size={22} /></Button>}
    </div>
  );
}
