import { useMemo, useState } from "react";
import type { FormEvent, MouseEvent } from "react";
import { Check, Plus, X } from "lucide-react";
import { initials } from "../utils/music";
import type { ContextPayload, Playlist, Track } from "../types";

export function PlaylistBrowser({
  playlists,
  selectedPlaylistId,
  tracks,
  queueIds,
  activeTrackId,
  onSelectPlaylist,
  onCreatePlaylist,
  onPlay,
  onContextMenu,
}: {
  playlists: Playlist[];
  selectedPlaylistId: string;
  tracks: Track[];
  queueIds: string[];
  activeTrackId: string | null;
  onSelectPlaylist: (id: string) => void;
  onCreatePlaylist: (name: string) => void;
  onPlay: (track: Track, sourceTracks?: Track[]) => void;
  onContextMenu: (event: MouseEvent, payload: ContextPayload) => void;
}) {
  const [isCreating, setIsCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const trackMap = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);
  const nowPlayingTracks = queueIds.map((id) => trackMap.get(id)).filter(Boolean) as Track[];
  const entries = [
    { id: "now", name: "now playing", description: "current queue", tracks: nowPlayingTracks },
    ...playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      tracks: playlist.trackIds.map((id) => trackMap.get(id)).filter(Boolean) as Track[],
    })),
  ];
  const selected = entries.find((item) => item.id === selectedPlaylistId) ?? entries[0];

  function submitPlaylist(event: FormEvent) {
    event.preventDefault();
    const cleanName = draftName.trim();
    if (!cleanName) return;

    onCreatePlaylist(cleanName);
    setDraftName("");
    setIsCreating(false);
  }

  return (
    <div className="playlist-browser">
      <section className="playlist-list">
        <p>{playlists.length} playlists</p>
        <div className="playlist-create">
          {isCreating ? (
            <form onSubmit={submitPlaylist}>
              <input
                autoFocus
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder="playlist name"
              />
              <button type="submit" title="Create playlist" disabled={!draftName.trim()}>
                <Check size={17} />
              </button>
              <button
                type="button"
                title="Cancel"
                onClick={() => {
                  setDraftName("");
                  setIsCreating(false);
                }}
              >
                <X size={17} />
              </button>
            </form>
          ) : (
            <button className="playlist-create-button" onClick={() => setIsCreating(true)}>
              <Plus size={18} />
              <span>new playlist</span>
            </button>
          )}
        </div>
        {entries.map((playlist) => (
          <button
            key={playlist.id}
            className={playlist.id === selected.id ? "selected" : ""}
            onClick={() => onSelectPlaylist(playlist.id)}
            onContextMenu={(event) =>
              onContextMenu(event, {
                kind: "album",
                title: playlist.name,
                subtitle: playlist.description,
                tracks: playlist.tracks,
              })
            }
          >
            <strong>{playlist.name}</strong>
            <span>{playlist.description}</span>
          </button>
        ))}
      </section>

      <section className="playlist-table">
        <div className="playlist-head">
          <span>#</span>
          <span>song</span>
          <span>artist</span>
          <span>album</span>
        </div>
        <div className="playlist-rows">
          {selected.tracks.length === 0 ? (
            <p className="quiet">right-click music and add it to this playlist</p>
          ) : (
            selected.tracks.map((track, index) => (
              <button
                key={track.id}
                className={track.id === activeTrackId ? "playing" : ""}
                onDoubleClick={() => onPlay(track, selected.tracks)}
                onContextMenu={(event) =>
                  onContextMenu(event, {
                    kind: "track",
                    title: track.title,
                    subtitle: `${track.artist} / ${track.album}`,
                    tracks: [track],
                  })
                }
              >
                <span>{index + 1}</span>
                <strong>{track.title}</strong>
                <em>{track.artist}</em>
                <small>{track.album}</small>
              </button>
            ))
          )}
        </div>
      </section>

      <aside className="playlist-detail">
        <div className="playlist-art">{initials(selected.name)}</div>
        <strong>{selected.name}</strong>
        <span>{selected.description}</span>
        <p>{selected.tracks.length} songs</p>
      </aside>
    </div>
  );
}
