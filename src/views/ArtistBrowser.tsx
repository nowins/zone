import type { MouseEvent } from "react";
import { Cover } from "../components/Cover";
import { artistReference, type CollectionArtist, type CollectionEntityRef } from "../utils/collectionEntities";
import type { ContextPayload } from "../types";

export function ArtistBrowser({ artists, onOpen, onContextMenu }: {
  artists: CollectionArtist[];
  onOpen: (entity: CollectionEntityRef) => void;
  onContextMenu: (event: MouseEvent, payload: ContextPayload) => void;
}) {
  return <ul className="collection-artist-index" aria-label="艺术家索引">{artists.map(artist => {
    const cover = [...artist.albums, ...artist.appearances].find(album => album.coverPath);
    return <li key={artist.artist} data-collection-anchor={`artist:${artist.artist}`}>
      <button type="button" className="collection-artist-entry" data-collection-focus={`artist-index:${artist.artist}`}
        title={artist.artist} onClick={() => onOpen(artistReference(artist))}
        onContextMenu={event => onContextMenu(event, { kind: "artist", title: artist.artist, subtitle: "艺术家",
          tracks: artist.tracks, targetId: artist.artist })}>
        <span className={`collection-artist-image${artist.imagePath ? " is-profile" : ""}`} aria-hidden="true">
          <Cover artPath={artist.imagePath || cover?.coverPath} label={artist.artist} />
          {!artist.imagePath && cover?.coverPath && <small>作品封面</small>}
        </span>
        <span className="collection-artist-copy"><strong>{artist.artist}</strong>
          <small>{artist.albums.length} 张专辑{artist.appearances.length > 0 ? ` · 参与 ${artist.appearances.length} 张` : ""} · {artist.tracks.length} 首歌曲</small>
        </span>
      </button>
    </li>;
  })}</ul>;
}
