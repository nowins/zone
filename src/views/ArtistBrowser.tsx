import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { Play } from "lucide-react";
import { Cover } from "../components/Cover";
import { CollectionAlbumTile } from "../components/CollectionAlbumTile";
import { CollectionTrackList } from "../components/CollectionTrackList";
import { albumKey, bestAlbumArtist, compareTracksForAlbum } from "../utils/music";
import type { ArtistGroup, ContextPayload, Track } from "../types";

export function ArtistBrowser({
  artists,
  initialArtist,
  activeTrackId,
  onPlay,
  onPlayTracks,
  onContextMenu,
  favoriteTrackIds,
  onToggleFavorite,
}: {
  artists: ArtistGroup[];
  initialArtist: string | null;
  activeTrackId: string | null;
  onPlay: (track: Track, sourceTracks?: Track[]) => void;
  onPlayTracks: (tracks: Track[]) => void;
  onContextMenu: (event: MouseEvent, payload: ContextPayload) => void;
  favoriteTrackIds: ReadonlySet<string>;
  onToggleFavorite: (track: Track) => void;
}) {
  const [selectedArtist, setSelectedArtist] = useState<string | null>(initialArtist ?? artists[0]?.artist ?? null);
  const [selectedAlbumKey, setSelectedAlbumKey] = useState<string | null>(null);
  const artist = artists.find((item) => item.artist === selectedArtist) ?? artists[0] ?? null;
  const artistAlbums = useMemo(() => {
    if (!artist) return [];
    const map = new Map<string, Track[]>();
    for (const track of artist.tracks) {
      const key = albumKey(track.album, track.album_artist ?? track.artist);
      map.set(key, [...(map.get(key) ?? []), track]);
    }

    return Array.from(map.entries())
      .map(([key, albumTracks]) => {
        const sortedTracks = [...albumTracks].sort(compareTracksForAlbum);
        return {
          key,
          artist: bestAlbumArtist(sortedTracks),
          album: sortedTracks[0]?.album ?? "未知专辑",
          tracks: sortedTracks,
          coverPath: sortedTracks.find((track) => track.cover_path)?.cover_path,
        };
      })
      .sort((a, b) => a.album.localeCompare(b.album));
  }, [artist]);
  const selectedAlbum = artistAlbums.find((album) => album.key === selectedAlbumKey) ?? artistAlbums[0] ?? null;
  const visibleSongs = selectedAlbum?.tracks ?? artist?.tracks ?? [];
  const artistImagePath = artist?.tracks
    .flatMap((track) => track.artist_images ?? [])
    .find((image) => image.path)?.path
    ?? artist?.tracks.find((track) => track.artist_image_path)?.artist_image_path;
  const artistBiography = artist?.tracks.find((track) => track.artist_biography)?.artist_biography;
  const hasArtistIdentity = Boolean(artistImagePath || artistBiography);

  useEffect(() => {
    if (initialArtist && artists.some((item) => item.artist === initialArtist)) {
      setSelectedArtist(initialArtist);
    }
  }, [artists, initialArtist]);

  useEffect(() => {
    if (!artists.length) {
      setSelectedArtist(null);
      return;
    }

    if (!selectedArtist || !artists.some((item) => item.artist === selectedArtist)) {
      setSelectedArtist(artists[0].artist);
    }
  }, [artists, selectedArtist]);

  useEffect(() => {
    if (!artistAlbums.length) {
      setSelectedAlbumKey(null);
      return;
    }

    if (!selectedAlbumKey || !artistAlbums.some((album) => album.key === selectedAlbumKey)) {
      setSelectedAlbumKey(artistAlbums[0].key);
    }
  }, [artistAlbums, selectedAlbumKey]);

  return (
    <div className="artist-browser">
      <section className="artist-column">
        {artist && hasArtistIdentity ? (
          <div
            className={`artist-identity${artistImagePath ? "" : " no-image"}`}
            onContextMenu={(event) => onContextMenu(event, {
              kind: "artist",
              title: artist.artist,
              subtitle: `${artist.tracks.length} 首歌曲`,
              tracks: artist.tracks,
            })}
          >
            {artistImagePath ? (
              <div className="artist-identity-art">
                <Cover artPath={artistImagePath} label={artist.artist} size="large" />
              </div>
            ) : null}
            <div className="artist-identity-copy">
              <strong>{artist.artist}</strong>
              {artistBiography ? <p>{artistBiography}</p> : null}
            </div>
          </div>
        ) : null}
        <div className="artist-picker">
          {artists.map((item) => (
            <button
              key={item.artist}
              className={item.artist === artist?.artist ? "selected" : ""}
              title={item.artist}
              aria-pressed={item.artist === artist?.artist}
              onClick={() => setSelectedArtist(item.artist)}
              onContextMenu={(event) =>
                onContextMenu(event, {
                  kind: "artist",
                  title: item.artist,
                  subtitle: `${item.tracks.length} 首歌曲`,
                  tracks: item.tracks,
                })
              }
            >
              {item.artist}
            </button>
          ))}
        </div>
      </section>

      <div className="artist-content">
        <h2 className="artist-content-title" title={artist?.artist}>{artist?.artist ?? "艺术家"}</h2>
        <div className="artist-records" data-sparse={artistAlbums.length === 1 || undefined}>
          <section className="artist-albums">
            <p>{artistAlbums.length} 张专辑</p>
            <div
              className="artist-album-grid"
              data-count={artistAlbums.length}
            >
              {artistAlbums.map((album, index) => (
                <CollectionAlbumTile
                  key={album.key}
                  className="artist-album-tile"
                  name={album.album} artist={album.artist} coverPath={album.coverPath} index={index}
                  selected={album.key === selectedAlbum?.key}
                  onSelect={() => setSelectedAlbumKey(album.key)}
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
          </section>

          <section className="artist-songs">
            <div className="album-detail-head">
              <div><strong title={selectedAlbum?.album}>{selectedAlbum?.album ?? "歌曲"}</strong><span>{visibleSongs.length} 首歌曲</span></div>
              <button type="button" disabled={visibleSongs.length === 0} onClick={() => onPlayTracks(visibleSongs)} title="播放全部">
                <Play size={18} fill="currentColor" />
              </button>
            </div>
            <CollectionTrackList key={selectedAlbum?.key ?? artist?.artist} tracks={visibleSongs} activeTrackId={activeTrackId}
              compact onPlay={onPlay} favoriteTrackIds={favoriteTrackIds} onToggleFavorite={onToggleFavorite}
              onContextMenu={(event, track) => onContextMenu(event, {
                kind: "track", title: track.title, subtitle: `${track.artist} / ${track.album}`,
                tracks: [track], playbackTracks: visibleSongs,
              })} />
          </section>
        </div>
      </div>
    </div>
  );
}
