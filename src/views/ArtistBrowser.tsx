import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { Play } from "lucide-react";
import { Cover } from "../components/Cover";
import { albumKey, bestAlbumArtist, compareTracksForAlbum } from "../utils/music";
import type { ArtistGroup, ContextPayload, Track } from "../types";

export function ArtistBrowser({
  artists,
  activeTrackId,
  onPlay,
  onPlayTracks,
  onContextMenu,
}: {
  artists: ArtistGroup[];
  activeTrackId: string | null;
  onPlay: (track: Track, sourceTracks?: Track[]) => void;
  onPlayTracks: (tracks: Track[]) => void;
  onContextMenu: (event: MouseEvent, payload: ContextPayload) => void;
}) {
  const [selectedArtist, setSelectedArtist] = useState<string | null>(artists[0]?.artist ?? null);
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
          album: sortedTracks[0]?.album ?? "Unknown album",
          tracks: sortedTracks,
          coverPath: sortedTracks.find((track) => track.cover_path)?.cover_path,
        };
      })
      .sort((a, b) => a.album.localeCompare(b.album));
  }, [artist]);
  const selectedAlbum = artistAlbums.find((album) => album.key === selectedAlbumKey) ?? artistAlbums[0] ?? null;
  const visibleSongs = selectedAlbum?.tracks ?? artist?.tracks ?? [];

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
        <p>{artists.length} artists</p>
        <div className="artist-picker">
          {artists.map((item) => (
            <button
              key={item.artist}
              className={item.artist === artist?.artist ? "selected" : ""}
              onClick={() => setSelectedArtist(item.artist)}
            >
              {item.artist}
            </button>
          ))}
        </div>
      </section>

      <section className="artist-albums">
        <p>{artistAlbums.length} albums</p>
        <div className="artist-album-grid">
          {artistAlbums.map((album, index) => (
            <div
              key={album.key}
              className={`artist-album-tile ${album.key === selectedAlbum?.key ? "selected" : ""}`}
              onClick={() => setSelectedAlbumKey(album.key)}
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
            </div>
          ))}
        </div>
      </section>

      <section className="artist-songs">
        <p>{visibleSongs.length} songs</p>
        <div className="artist-song-list">
          {visibleSongs.map((track, index) => (
            <button
              key={track.id}
              className={track.id === activeTrackId ? "playing" : ""}
              onDoubleClick={() => onPlay(track, visibleSongs)}
              onContextMenu={(event) =>
                onContextMenu(event, {
                  kind: "track",
                  title: track.title,
                  subtitle: `${track.artist} / ${track.album}`,
                  tracks: [track],
                  playbackTracks: visibleSongs,
                })
              }
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{track.title}</strong>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
