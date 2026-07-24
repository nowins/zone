import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { ChevronRight } from "lucide-react";
import { Cover } from "../components/Cover";
import { isSmartPlaylist } from "../utils/smartPlaylist";
import { searchLibrary } from "../utils/librarySearch";
import type {
  AlbumGroup,
  ArtistGroup,
  ContextPayload,
  Playlist,
  Track,
  TrackActivityMap,
} from "../types";

type SearchFilter = "all" | "artists" | "albums" | "songs" | "playlists";

const FILTER_LABELS: Record<SearchFilter, string> = {
  all: "全部",
  artists: "艺术家",
  albums: "专辑",
  songs: "歌曲",
  playlists: "播放列表",
};

export function SearchResultsView({
  query,
  tracks,
  albums,
  artists,
  playlists,
  activity,
  favoriteTrackIds,
  activeTrackId,
  onPlay,
  onOpenArtist,
  onOpenAlbum,
  onOpenPlaylist,
  onContextMenu,
}: {
  query: string;
  tracks: Track[];
  albums: AlbumGroup[];
  artists: ArtistGroup[];
  playlists: Playlist[];
  activity: TrackActivityMap;
  favoriteTrackIds: ReadonlySet<string>;
  activeTrackId: string | null;
  onPlay: (track: Track, sourceTracks?: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  onOpenAlbum: (albumKey: string) => void;
  onOpenPlaylist: (playlistId: string) => void;
  onContextMenu: (event: MouseEvent, payload: ContextPayload) => void;
}) {
  const [filter, setFilter] = useState<SearchFilter>("all");
  const results = useMemo(() => searchLibrary({
    query,
    tracks,
    albums,
    artists,
    playlists,
    favoriteTrackIds,
    activity,
  }), [activity, albums, artists, favoriteTrackIds, playlists, query, tracks]);

  useEffect(() => {
    setFilter("all");
  }, [query]);

  const counts: Record<SearchFilter, number> = {
    all: results.total,
    artists: results.artists.length,
    albums: results.albums.length,
    songs: results.tracks.length,
    playlists: results.playlists.length,
  };
  const showArtists = filter === "all" || filter === "artists";
  const showAlbums = filter === "all" || filter === "albums";
  const showSongs = filter === "all" || filter === "songs";
  const showPlaylists = filter === "all" || filter === "playlists";
  const artistResults = filter === "all" ? results.artists.slice(0, 5) : results.artists;
  const albumResults = filter === "all" ? results.albums.slice(0, 5) : results.albums;
  const trackResults = filter === "all" ? results.tracks.slice(0, 7) : results.tracks;
  const playlistResults = filter === "all" ? results.playlists.slice(0, 5) : results.playlists;

  return (
    <div className="search-results-view" id="collection-search-results">
      <header className="search-results-heading">
        <p>收藏 / 搜索</p>
        <h1 title={query}>
          <strong>“{query.trim()}”</strong>
          <span>的结果</span>
        </h1>
        <p className="search-results-summary" role="status" aria-live="polite">
          {results.total > 0 ? `共找到 ${results.total} 项内容` : "没有找到匹配的内容"}
        </p>
      </header>

      <div className="search-results-layout">
        <aside className="search-filter" aria-label="搜索结果筛选">
          <h2>筛选</h2>
          {(Object.keys(FILTER_LABELS) as SearchFilter[]).map((item) => (
            <button
              key={item}
              className={filter === item ? "selected" : ""}
              onClick={() => setFilter(item)}
              aria-pressed={filter === item}
            >
              <span>{FILTER_LABELS[item]}</span>
              <small>{counts[item]}</small>
            </button>
          ))}
        </aside>

        <div className="search-results-scroll">
          {results.total === 0 ? (
            <div className="search-empty">
              <strong>没有找到“{query.trim()}”</strong>
              <span>试试歌曲、艺术家、专辑或播放列表名称。</span>
            </div>
          ) : null}

          {showArtists && results.artists.length > 0 ? (
            <section className="search-result-section">
              <SearchSectionHeading
                label="艺术家"
                count={results.artists.length}
                canExpand={filter === "all" && results.artists.length > artistResults.length}
                onExpand={() => setFilter("artists")}
              />
              <div className="search-artist-list">
                {artistResults.map((artist) => (
                  <button
                    key={artist.artist}
                    className="search-artist-result"
                    onClick={() => onOpenArtist(artist.artist)}
                    onContextMenu={(event) => onContextMenu(event, {
                      kind: "artist",
                      title: artist.artist,
                      subtitle: `${artist.tracks.length} 首歌曲`,
                      tracks: artist.tracks,
                    })}
                  >
                    <span>{artist.artist}</span>
                    <small>{artist.tracks.length} 首歌曲</small>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {showAlbums && results.albums.length > 0 ? (
            <section className="search-result-section">
              <SearchSectionHeading
                label="专辑"
                count={results.albums.length}
                canExpand={filter === "all" && results.albums.length > albumResults.length}
                onExpand={() => setFilter("albums")}
              />
              <div className="search-album-grid">
                {albumResults.map((album, index) => (
                  <button
                    key={album.key}
                    className="search-album-result"
                    onClick={() => onOpenAlbum(album.key)}
                    onContextMenu={(event) => onContextMenu(event, {
                      kind: "album",
                      title: album.album,
                      subtitle: album.artist,
                      tracks: album.tracks,
                    })}
                  >
                    <Cover
                      artPath={album.coverPath}
                      label={album.album}
                      size="large"
                      index={index}
                    />
                    <strong title={album.album}>{album.album}</strong>
                    <span title={album.artist}>{album.artist}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {showSongs && results.tracks.length > 0 ? (
            <section className="search-result-section">
              <SearchSectionHeading
                label="歌曲"
                count={results.tracks.length}
                canExpand={filter === "all" && results.tracks.length > trackResults.length}
                onExpand={() => setFilter("songs")}
              />
              <div className="search-song-list">
                <div className="search-song-head" aria-hidden="true">
                  <span>#</span>
                  <span>歌曲</span>
                  <span>艺术家</span>
                  <span>专辑</span>
                </div>
                {trackResults.map((track, index) => (
                  <button
                    key={track.id}
                    className={`search-song-result ${track.id === activeTrackId ? "active" : ""}`}
                    onClick={() => onPlay(track, results.tracks)}
                    onContextMenu={(event) => onContextMenu(event, {
                      kind: "track",
                      title: track.title,
                      subtitle: `${track.artist} · ${track.album}`,
                      tracks: [track],
                      playbackTracks: results.tracks,
                    })}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong title={track.title}>{track.title}</strong>
                    <span title={track.artist}>{track.artist}</span>
                    <span title={track.album}>{track.album}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {showPlaylists && results.playlists.length > 0 ? (
            <section className="search-result-section">
              <SearchSectionHeading
                label="播放列表"
                count={results.playlists.length}
                canExpand={filter === "all" && results.playlists.length > playlistResults.length}
                onExpand={() => setFilter("playlists")}
              />
              <div className="search-playlist-list">
                {playlistResults.map(({ playlist, tracks: playlistTracks }) => (
                  <button
                    key={playlist.id}
                    className="search-playlist-result"
                    onClick={() => onOpenPlaylist(playlist.id)}
                    onContextMenu={(event) => onContextMenu(event, {
                      kind: "playlist",
                      title: playlist.name,
                      subtitle: playlist.description || `${playlistTracks.length} 首歌曲`,
                      tracks: playlistTracks,
                      playlistId: playlist.id,
                      playlistKind: isSmartPlaylist(playlist) ? "smart" : "manual",
                    })}
                  >
                    <span>
                      <strong>{playlist.name}</strong>
                      <small>{playlist.description}</small>
                    </span>
                    <em>{playlistTracks.length} 首歌曲</em>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SearchSectionHeading({
  label,
  count,
  canExpand,
  onExpand,
}: {
  label: string;
  count: number;
  canExpand: boolean;
  onExpand: () => void;
}) {
  return (
    <div className="search-section-heading">
      <h2>{label} <span>({count})</span></h2>
      {canExpand ? (
        <button onClick={onExpand}>
          查看全部
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
