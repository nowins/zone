import type { MouseEvent } from "react";
import { CollectionAlbumTile } from "../components/CollectionAlbumTile";
import { CollectionTrackList } from "../components/CollectionTrackList";
import { albumReference, type CollectionEntityRef, type CollectionIndex } from "../utils/collectionEntities";
import { ArtistBrowser } from "./ArtistBrowser";
import { PlaylistBrowser } from "./PlaylistBrowser";
import type { AlbumGroup, ContextPayload, Playlist, Track, TrackActivityMap, ViewMode } from "../types";

export type LibraryViewProps = {
  view: ViewMode;
  index: CollectionIndex;
  queueIds: string[];
  activeTrackId: string | null;
  onOpen: (entity: CollectionEntityRef) => void;
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
  onReorderPlaylist?: (playlistId: string, trackId: string, targetId: string) => void;
};

export function AlbumIndex({ albums, onOpen, onPlayTracks, onContextMenu }: {
  albums: AlbumGroup[];
} & Pick<LibraryViewProps, "onOpen" | "onPlayTracks" | "onContextMenu">) {
  return <div className="collection-album-index">{albums.map((album, index) =>
    <div key={album.key} data-collection-anchor={`album:${album.key}`}>
      <CollectionAlbumTile name={album.album} artist={album.artist} coverPath={album.coverPath} index={index}
        focusKey={`album-index:${album.key}`} onSelect={() => onOpen(albumReference(album))}
        onPlay={() => onPlayTracks(album.tracks)} onContextMenu={event => onContextMenu(event, {
          kind: "album", title: album.album, subtitle: album.artist, tracks: album.tracks, targetId: album.key,
        })} />
    </div>)}</div>;
}

export function LibraryView(props: LibraryViewProps) {
  const { view, index, activeTrackId, onPlay, favoriteTrackIds, onToggleFavorite, onContextMenu } = props;
  if (view === "playlists") return <PlaylistBrowser {...props} tracks={index.tracks} activity={props.trackActivity} />;
  if (view === "songs") return <CollectionTrackList tracks={index.tracks} activeTrackId={activeTrackId} onPlay={onPlay}
    listKey="songs" label="所有歌曲" favoriteTrackIds={favoriteTrackIds} onToggleFavorite={onToggleFavorite}
    onContextMenu={(event, track) => onContextMenu(event, { kind: "track", title: track.title,
      subtitle: `${track.artist} / ${track.album}`, tracks: [track], playbackTracks: index.tracks })} />;
  return <div className="collection-index-scroll" data-collection-scroll={`index:${view}`}>
    {view === "artists" ? <ArtistBrowser artists={index.artists} onOpen={props.onOpen} onContextMenu={onContextMenu} />
      : <AlbumIndex albums={index.albums} {...props} />}
  </div>;
}
