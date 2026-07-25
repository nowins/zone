import type { MouseEvent } from "react";
import { Play } from "lucide-react";
import { Cover } from "../components/Cover";
import { ArtistBrowser } from "./ArtistBrowser";
import { PlaylistBrowser } from "./PlaylistBrowser";
import type { AlbumGroup, ArtistGroup, ContextPayload, Playlist, Track, ViewMode } from "../types";

export function LibraryView({
  view,
  tracks,
  albums,
  artists,
  queueIds,
  activeTrackId,
  selectedAlbumKey,
  onSelectAlbum,
  onPlay,
  onPlayTracks,
  onContextMenu,
  playlists,
  selectedPlaylistId,
  onSelectPlaylist,
  onCreatePlaylist,
}: {
  view: ViewMode;
  tracks: Track[];
  albums: AlbumGroup[];
  artists: ArtistGroup[];
  queueIds: string[];
  activeTrackId: string | null;
  selectedAlbumKey: string | null;
  onSelectAlbum: (key: string) => void;
  onPlay: (track: Track, sourceTracks?: Track[]) => void;
  onPlayTracks: (tracks: Track[]) => void;
  onContextMenu: (event: MouseEvent, payload: ContextPayload) => void;
  playlists: Playlist[];
  selectedPlaylistId: string;
  onSelectPlaylist: (id: string) => void;
  onCreatePlaylist: (name: string) => void;
}) {
  if (view === "albums") {
    const selectedAlbum = albums.find((album) => album.key === selectedAlbumKey) ?? albums[0] ?? null;

    return (
      <div className="album-browser">
        <div className="album-rail">
          {albums.map((album, index) => (
            <div
              key={album.key}
              className={`album-tile ${album.key === selectedAlbum?.key ? "selected" : ""}`}
              onClick={() => onSelectAlbum(album.key)}
              onContextMenu={(event) =>
                onContextMenu(event, {
                  kind: "album",
                  title: album.album,
                  subtitle: album.artist,
                  tracks: album.tracks,
                })
              }
            >
              <div className="album-cover-wrap">
                <Cover artPath={album.coverPath} label={album.album} size="large" index={index} />
                <button
                  className="album-play"
                  onClick={(event) => {
                    event.stopPropagation();
                    onPlayTracks(album.tracks);
                  }}
                  title={`Play ${album.album}`}
                >
                  <Play size={20} />
                </button>
              </div>
              <strong>{album.album}</strong>
              <span>{album.artist}</span>
              <small>{album.tracks.length} songs</small>
            </div>
          ))}
        </div>

        <aside className="album-detail">
          {selectedAlbum ? (
            <>
              <div className="album-detail-head">
                <Cover artPath={selectedAlbum.coverPath} label={selectedAlbum.album} size="mini" />
                <div>
                  <strong>{selectedAlbum.album}</strong>
                  <span>{selectedAlbum.artist}</span>
                </div>
              </div>
              <div className="album-track-list">
                {selectedAlbum.tracks.map((track, index) => (
                  <button
                    key={track.id}
                    className={track.id === activeTrackId ? "playing" : ""}
                    onDoubleClick={() => onPlay(track, selectedAlbum.tracks)}
                    onClick={() => undefined}
                    onContextMenu={(event) =>
                      onContextMenu(event, {
                        kind: "track",
                        title: track.title,
                        subtitle: `${track.artist} / ${track.album}`,
                        tracks: [track],
                      })
                    }
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{track.title}</strong>
                    <em>{track.artist}</em>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="quiet">no album selected</p>
          )}
        </aside>
      </div>
    );
  }

  if (view === "artists") {
    return (
      <ArtistBrowser
        artists={artists}
        activeTrackId={activeTrackId}
        onPlay={onPlay}
        onPlayTracks={onPlayTracks}
        onContextMenu={onContextMenu}
      />
    );
  }

  if (view === "playlists") {
    return (
      <PlaylistBrowser
        playlists={playlists}
        selectedPlaylistId={selectedPlaylistId}
        tracks={tracks}
        queueIds={queueIds}
        activeTrackId={activeTrackId}
        onSelectPlaylist={onSelectPlaylist}
        onCreatePlaylist={onCreatePlaylist}
        onPlay={onPlay}
        onContextMenu={onContextMenu}
      />
    );
  }

  return (
    <div className="song-list">
      {tracks.map((track, index) => (
        <button
          key={track.id}
          className={track.id === activeTrackId ? "playing" : ""}
          onDoubleClick={() => onPlay(track, tracks)}
          onClick={() => onPlay(track, tracks)}
          onContextMenu={(event) =>
            onContextMenu(event, {
              kind: "track",
              title: track.title,
              subtitle: `${track.artist} / ${track.album}`,
              tracks: [track],
            })
          }
        >
          <span>{String(index + 1).padStart(2, "0")}</span>
          <strong>{track.title}</strong>
          <em>{track.artist}</em>
          <small>{track.album}</small>
        </button>
      ))}
    </div>
  );
}
