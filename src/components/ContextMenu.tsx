import type { MouseEvent } from "react";
import { Info } from "lucide-react";
import { DEFAULT_PLAYLIST_ID } from "../constants";
import type { ContextMenuState, Playlist } from "../types";

export function ContextMenu({
  menu,
  playlists,
  onClose,
  onPlay,
  onAddToQueue,
  onAddToPlaylist,
  onInfo,
}: {
  menu: ContextMenuState;
  playlists: Playlist[];
  onClose: () => void;
  onPlay: () => void;
  onAddToQueue: () => void;
  onAddToPlaylist: (playlistId: string) => void;
  onInfo: () => void;
}) {
  function run(action: () => void) {
    action();
    onClose();
  }

  return (
    <div
      className="context-menu"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="context-title">
        <strong>{menu.payload.title}</strong>
        <span>{menu.payload.subtitle}</span>
      </div>
      <button onClick={() => run(onPlay)}>play</button>
      <button onClick={() => run(onAddToQueue)}>add to now playing</button>
      <button onClick={() => run(() => onAddToPlaylist(DEFAULT_PLAYLIST_ID))}>add to favorites</button>
      {playlists.some((playlist) => playlist.id !== DEFAULT_PLAYLIST_ID) && (
        <div className="context-section">
          <span>add to playlist</span>
          {playlists
            .filter((playlist) => playlist.id !== DEFAULT_PLAYLIST_ID)
            .map((playlist) => (
              <button key={playlist.id} onClick={() => run(() => onAddToPlaylist(playlist.id))}>
                {playlist.name}
              </button>
            ))}
        </div>
      )}
      <button onClick={() => run(onInfo)}>
        <Info size={16} />
        <span>view info</span>
      </button>
    </div>
  );
}
