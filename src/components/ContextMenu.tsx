import { useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Ban, Disc3, FolderOpen, Heart, Info, ListMusic, ListPlus, Pencil, Pin, PinOff, Play, Radio, SlidersHorizontal, Trash2, UserRound } from "lucide-react";
import { DEFAULT_PLAYLIST_ID } from "../constants";
import type { ContextMenuState } from "../types";

export function ContextMenu({
  menu,
  onClose,
  onPlay,
  onAddToQueue,
  onPlayNext,
  onStartSmartDj,
  onDislikeSmartDj,
  onAddToPlaylist,
  onAddToFavorites,
  onRenamePlaylist,
  onDeletePlaylist,
  onExcludeFromSmartPlaylist,
  homePinState,
  onToggleHomePin,
  onOpenInCollection,
  onOpenArtist,
  onOpenAlbum,
  onRemoveFromPlaylist,
  onMoveInPlaylist,
  onInfo,
}: {
  menu: ContextMenuState;
  onClose: () => void;
  onPlay: () => void;
  onAddToQueue: () => void;
  onPlayNext: () => void;
  onStartSmartDj: () => void;
  onDislikeSmartDj?: () => void;
  onAddToPlaylist: () => void;
  onAddToFavorites: () => void;
  onRenamePlaylist: (playlistId: string) => void;
  onDeletePlaylist: (playlistId: string) => void;
  onExcludeFromSmartPlaylist: (playlistId: string) => void;
  homePinState: "pinned" | "unpinned" | null;
  onToggleHomePin: () => void;
  onOpenInCollection?: () => void;
  onOpenArtist?: () => void;
  onOpenAlbum?: () => void;
  onRemoveFromPlaylist?: () => void;
  onMoveInPlaylist?: { up?: () => void; down?: () => void };
  onInfo: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef(document.activeElement as HTMLElement | null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y, ready: false });
  const sourcePlaylistId = menu.payload.playlistId;
  const isPlaylist = menu.payload.kind === "playlist";
  const isSmartSource = menu.payload.playlistKind === "smart";
  const canEditPlaylist = isPlaylist
    && Boolean(sourcePlaylistId)
    && sourcePlaylistId !== "now"
    && sourcePlaylistId !== DEFAULT_PLAYLIST_ID;

  useLayoutEffect(() => {
    function placeMenu() {
      const element = menuRef.current;
      if (!element) return;

      const gutter = 12;
      const rect = element.getBoundingClientRect();
      const maxLeft = Math.max(gutter, window.innerWidth - rect.width - gutter);
      const maxTop = Math.max(gutter, window.innerHeight - rect.height - gutter);
      setPosition({
        left: Math.min(Math.max(gutter, menu.x), maxLeft),
        top: Math.min(Math.max(gutter, menu.y), maxTop),
        ready: true,
      });
    }

    placeMenu();
    window.addEventListener("resize", placeMenu);
    return () => window.removeEventListener("resize", placeMenu);
  }, [menu.x, menu.y, menu.payload]);

  useLayoutEffect(() => {
    if (position.ready) menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [position.ready]);

  function run(action: () => void) {
    returnFocus.current?.focus({ preventScroll: true });
    action();
    onClose();
  }

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={`${menu.payload.title} 的操作`}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={event => {
        const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        } else if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault(); event.stopPropagation(); returnFocus.current?.focus({ preventScroll: true }); onClose();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="context-actions">
        <button role="menuitem" onClick={() => run(onPlay)} disabled={menu.payload.tracks.length === 0}>
          <Play size={17} />
          <span>播放</span>
        </button>
        <button role="menuitem" onClick={() => run(onPlayNext)} disabled={menu.payload.tracks.length === 0}>
          <ListPlus size={17} />
          <span>下一首播放</span>
        </button>
        <button role="menuitem" onClick={() => run(onAddToQueue)} disabled={menu.payload.tracks.length === 0}>
          <ListMusic size={17} />
          <span>添加到队列末尾</span>
        </button>
        <button role="menuitem" onClick={() => run(onStartSmartDj)} disabled={menu.payload.tracks.length === 0}>
          <Radio size={17} />
          <span>开始 SmartDJ</span>
        </button>
        {onDislikeSmartDj && (
          <button role="menuitem" onClick={() => run(onDislikeSmartDj)}>
            <Ban size={17} />
            <span>SmartDJ 不喜欢这首</span>
          </button>
        )}
        {homePinState && (
          <button role="menuitem" onClick={() => run(onToggleHomePin)}>
            {homePinState === "pinned" ? <PinOff size={17} /> : <Pin size={17} />}
            <span>{homePinState === "pinned" ? "从 quickplay 取消固定" : "固定到 quickplay"}</span>
          </button>
        )}
        {!isPlaylist && (
          <button role="menuitem" onClick={() => run(onAddToFavorites)}>
            <Heart size={17} />
            <span>添加到喜欢的歌曲</span>
          </button>
        )}
      </div>
      {!isPlaylist && (
        <div className="context-actions context-actions-secondary">
          <button role="menuitem" onClick={() => run(onAddToPlaylist)}>
            <ListMusic size={16} />
            <span>添加到播放列表</span>
          </button>
        </div>
      )}
      <div className="context-actions context-actions-secondary">
        {onRemoveFromPlaylist && <button role="menuitem" onClick={() => run(onRemoveFromPlaylist)}>
          <ListMusic size={16} /><span>从播放列表中移除</span>
        </button>}
        {onMoveInPlaylist && <>
          <button role="menuitem" disabled={!onMoveInPlaylist.up} onClick={() => onMoveInPlaylist.up && run(onMoveInPlaylist.up)}><ArrowUp size={16} /><span>在列表中上移</span></button>
          <button role="menuitem" disabled={!onMoveInPlaylist.down} onClick={() => onMoveInPlaylist.down && run(onMoveInPlaylist.down)}><ArrowDown size={16} /><span>在列表中下移</span></button>
        </>}
        {!isPlaylist && isSmartSource && sourcePlaylistId && (
          <button role="menuitem" onClick={() => run(() => onExcludeFromSmartPlaylist(sourcePlaylistId))}>
            <Ban size={16} />
            <span>从这个智能列表中排除</span>
          </button>
        )}
        {canEditPlaylist && sourcePlaylistId && (
          <>
            <button role="menuitem" onClick={() => run(() => onRenamePlaylist(sourcePlaylistId))}>
              {isSmartSource ? <SlidersHorizontal size={16} /> : <Pencil size={16} />}
              <span>{isSmartSource ? "编辑规则" : "重命名"}</span>
            </button>
            <button className="context-danger" role="menuitem" onClick={() => run(() => onDeletePlaylist(sourcePlaylistId))}>
              <Trash2 size={16} />
              <span>删除播放列表</span>
            </button>
          </>
        )}
        {!isPlaylist && <button role="menuitem" onClick={() => run(onInfo)}>
          <Info size={16} />
          <span>{menu.payload.kind === "track" ? "文件与资料" : "编辑资料"}</span>
        </button>}
        {onOpenInCollection && (
          <button role="menuitem" onClick={() => run(onOpenInCollection)}>
            <FolderOpen size={16} />
            <span>查看{{ track: "歌曲", album: "专辑", artist: "艺术家", playlist: "播放列表" }[menu.payload.kind]}</span>
          </button>
        )}
        {onOpenArtist && <button role="menuitem" onClick={() => run(onOpenArtist)}><UserRound size={16} /><span>前往艺术家</span></button>}
        {onOpenAlbum && <button role="menuitem" onClick={() => run(onOpenAlbum)}><Disc3 size={16} /><span>前往专辑</span></button>}
      </div>
    </div>
  );
}
