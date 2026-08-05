import { useLayoutEffect, useRef, useState } from "react";
import { Ban, Heart, Info, ListMusic, ListPlus, Pencil, Pin, PinOff, Play, Radio, SlidersHorizontal, Trash2 } from "lucide-react";
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
  onInfo: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
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

  function run(action: () => void) {
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
            <span>添加到收藏</span>
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
        <button role="menuitem" onClick={() => run(onInfo)}>
          <Info size={16} />
          <span>查看信息</span>
        </button>
      </div>
    </div>
  );
}
