import type { MouseEvent } from "react";
import { Play } from "lucide-react";
import { CollectionAlbumTile } from "../components/CollectionAlbumTile";
import { CollectionTrackList } from "../components/CollectionTrackList";
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
  if (view === "albums") {
    const selectedAlbum = albums.find((album) => album.key === selectedAlbumKey) ?? albums[0] ?? null;

    return (
      <div className="album-browser">
        <div className="album-rail">
          {albums.map((album, index) => (
            <CollectionAlbumTile
              key={album.key}
              name={album.album} artist={album.artist} coverPath={album.coverPath} index={index}
              selected={album.key === selectedAlbum?.key}
              onSelect={() => onSelectAlbum(album.key)}
              onPlay={() => onPlayTracks(album.tracks)}
              onContextMenu={(event) =>
                onContextMenu(event, {
                  kind: "album",
                  title: album.album,
                  subtitle: album.artist,
                  tracks: album.tracks,
                  targetId: album.key,
                })
              }
            />
          ))}
        </div>

        <aside className="album-detail">
          {selectedAlbum ? (
            <>
              <div className="album-detail-head">
                <div>
                  <strong title={selectedAlbum.album}>{selectedAlbum.album}</strong>
                  <span title={selectedAlbum.artist}>{selectedAlbum.tracks.length} 首歌曲 · {selectedAlbum.artist}</span>
                </div>
                <button onClick={() => onPlayTracks(selectedAlbum.tracks)} title={`播放 ${selectedAlbum.album}`}>
                  <Play size={20} fill="currentColor" />
                </button>
              </div>
              <CollectionTrackList key={selectedAlbum.key} tracks={selectedAlbum.tracks} activeTrackId={activeTrackId}
                compact onPlay={onPlay} favoriteTrackIds={favoriteTrackIds} onToggleFavorite={onToggleFavorite}
                onContextMenu={(event, track) => onContextMenu(event, {
                  kind: "track", title: track.title, subtitle: `${track.artist} / ${track.album}`,
                  tracks: [track], playbackTracks: selectedAlbum.tracks,
                })} />
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
        favoriteTrackIds={favoriteTrackIds}
        onToggleFavorite={onToggleFavorite}
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
        onToggleFavorite={onToggleFavorite}
        activity={trackActivity}
      />
    );
  }

  return (
    <CollectionTrackList tracks={tracks} activeTrackId={activeTrackId} onPlay={onPlay}
      favoriteTrackIds={favoriteTrackIds} onToggleFavorite={onToggleFavorite}
      onContextMenu={(event, track) => onContextMenu(event, {
        kind: "track", title: track.title, subtitle: `${track.artist} / ${track.album}`,
        tracks: [track], playbackTracks: tracks,
      })} />
  );
}
