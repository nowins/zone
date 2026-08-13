import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { Heart, Play } from "lucide-react";
import { Cover } from "../components/Cover";
import { tiltPressClear, tiltPressDown } from "../utils/tiltPress";
import { ArtistBrowser } from "./ArtistBrowser";
import { PlaylistBrowser } from "./PlaylistBrowser";
import type { AlbumGroup, ArtistGroup, ContextPayload, Playlist, Track, TrackActivityMap, ViewMode } from "../types";

export function LibraryView({
  view,
  tracks,
  libraryTracks,
  albums,
  artists,
  queueIds,
  activeTrackId,
  selectedAlbumKey,
  onSelectAlbum,
  selectedArtistName,
  onPlay,
  onPlayTracks,
  onContextMenu,
  playlists,
  selectedPlaylistId,
  onSelectPlaylist,
  onCreatePlaylist,
  onEditSmartPlaylist,
  onRefreshSmartPlaylist,
  trackActivity,
  favoriteTrackIds,
  onToggleFavorite,
}: {
  view: ViewMode;
  tracks: Track[];
  libraryTracks: Track[];
  albums: AlbumGroup[];
  artists: ArtistGroup[];
  queueIds: string[];
  activeTrackId: string | null;
  selectedAlbumKey: string | null;
  onSelectAlbum: (key: string) => void;
  selectedArtistName: string | null;
  onPlay: (track: Track, sourceTracks?: Track[]) => void;
  onPlayTracks: (tracks: Track[]) => void;
  onContextMenu: (event: MouseEvent, payload: ContextPayload) => void;
  playlists: Playlist[];
  selectedPlaylistId: string;
  onSelectPlaylist: (id: string) => void;
  onCreatePlaylist: () => void;
  onEditSmartPlaylist: (playlistId: string) => void;
  onRefreshSmartPlaylist: (playlistId: string) => void;
  trackActivity: TrackActivityMap;
  favoriteTrackIds: Set<string>;
  onToggleFavorite: (track: Track) => void;
}) {
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(activeTrackId);

  useEffect(() => {
    if (activeTrackId) setSelectedTrackId(activeTrackId);
  }, [activeTrackId]);

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
              onPointerDown={tiltPressDown}
              onPointerUp={tiltPressClear}
              onPointerLeave={tiltPressClear}
              onPointerCancel={tiltPressClear}
              onContextMenu={(event) =>
                onContextMenu(event, {
                  kind: "album",
                  title: album.album,
                  subtitle: album.artist,
                  tracks: album.tracks,
                  targetId: album.key,
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
                  title={`播放 ${album.album}`}
                >
                  <Play size={20} />
                </button>
              </div>
              <strong>{album.album}</strong>
              <span>{album.artist}</span>
            </div>
          ))}
        </div>

        <aside className="album-detail">
          {selectedAlbum ? (
            <>
              <div className="album-detail-head">
                <div>
                  <strong>{selectedAlbum.album}</strong>
                  <span>{selectedAlbum.tracks.length} 首歌曲 · {selectedAlbum.artist}</span>
                </div>
                <button onClick={() => onPlayTracks(selectedAlbum.tracks)} title={`播放 ${selectedAlbum.album}`}>
                  <Play size={20} fill="currentColor" />
                </button>
              </div>
              <div className="album-track-list">
                {selectedAlbum.tracks.map((track, index) => (
                  <div
                    key={track.id}
                    className={`album-track-row ${track.id === selectedTrackId ? "selected" : ""} ${track.id === activeTrackId ? "playing" : ""}`}
                    onContextMenu={(event) =>
                      onContextMenu(event, {
                        kind: "track",
                        title: track.title,
                        subtitle: `${track.artist} / ${track.album}`,
                        tracks: [track],
                        playbackTracks: selectedAlbum.tracks,
                      })
                    }
                  >
                    <button
                      className="album-track-main"
                      onClick={() => setSelectedTrackId(track.id)}
                      onDoubleClick={() => onPlay(track, selectedAlbum.tracks)}
                    >
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <span className="track-copy">
                        <strong>{track.title}</strong>
                        <em>{track.artist} · {track.album}</em>
                      </span>
                    </button>
                    <button
                      className={`track-favorite ${favoriteTrackIds.has(track.id) ? "active" : ""}`}
                      onClick={() => onToggleFavorite(track)}
                      title={favoriteTrackIds.has(track.id) ? "取消收藏" : "收藏"}
                    >
                      <Heart size={16} fill={favoriteTrackIds.has(track.id) ? "currentColor" : "none"} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="quiet">尚未选择专辑</p>
          )}
        </aside>
      </div>
    );
  }

  if (view === "artists") {
    return (
      <ArtistBrowser
        artists={artists}
        initialArtist={selectedArtistName}
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
        tracks={libraryTracks}
        queueIds={queueIds}
        activeTrackId={activeTrackId}
        onSelectPlaylist={onSelectPlaylist}
        onCreatePlaylist={onCreatePlaylist}
        onPlay={onPlay}
        onPlayTracks={onPlayTracks}
        onEditSmartPlaylist={onEditSmartPlaylist}
        onRefreshSmartPlaylist={onRefreshSmartPlaylist}
        onContextMenu={onContextMenu}
        favoriteTrackIds={favoriteTrackIds}
        activity={trackActivity}
      />
    );
  }

  return (
    <div className="song-list">
      {tracks.map((track, index) => (
        <div
          key={track.id}
          className={`song-row ${track.id === activeTrackId ? "playing" : ""}`}
          onContextMenu={(event) =>
            onContextMenu(event, {
              kind: "track",
              title: track.title,
              subtitle: `${track.artist} / ${track.album}`,
              tracks: [track],
              playbackTracks: tracks,
            })
          }
        >
          <button className="song-row-main" onDoubleClick={() => onPlay(track, tracks)} onClick={() => onPlay(track, tracks)}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{track.title}</strong>
            <em>{track.artist}</em>
            <small>{track.album}</small>
          </button>
          <button
            className={`track-favorite ${favoriteTrackIds.has(track.id) ? "active" : ""}`}
            onClick={() => onToggleFavorite(track)}
            title={favoriteTrackIds.has(track.id) ? "取消收藏" : "收藏"}
          >
            <Heart size={16} fill={favoriteTrackIds.has(track.id) ? "currentColor" : "none"} />
          </button>
        </div>
      ))}
    </div>
  );
}
