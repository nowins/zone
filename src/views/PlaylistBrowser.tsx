import { useMemo } from "react";
import type { MouseEvent } from "react";
import { Play, Plus, RefreshCw, SlidersHorizontal, Sparkles } from "lucide-react";
import { DEFAULT_PLAYLIST_ID } from "../constants";
import { initials } from "../utils/music";
import { isSmartPlaylist, resolvePlaylistTracks } from "../utils/smartPlaylist";
import type { ContextPayload, Playlist, Track, TrackActivityMap } from "../types";

export function PlaylistBrowser({
  playlists,
  selectedPlaylistId,
  tracks,
  queueIds,
  activeTrackId,
  onSelectPlaylist,
  onCreatePlaylist,
  onPlay,
  onPlayTracks,
  onEditSmartPlaylist,
  onRefreshSmartPlaylist,
  onContextMenu,
  favoriteTrackIds,
  activity,
}: {
  playlists: Playlist[];
  selectedPlaylistId: string;
  tracks: Track[];
  queueIds: string[];
  activeTrackId: string | null;
  onSelectPlaylist: (id: string) => void;
  onCreatePlaylist: () => void;
  onPlay: (track: Track, sourceTracks?: Track[]) => void;
  onPlayTracks: (tracks: Track[]) => void;
  onEditSmartPlaylist: (playlistId: string) => void;
  onRefreshSmartPlaylist: (playlistId: string) => void;
  onContextMenu: (event: MouseEvent, payload: ContextPayload) => void;
  favoriteTrackIds: ReadonlySet<string>;
  activity: TrackActivityMap;
}) {
  const trackMap = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);
  const entries = useMemo(() => {
    const nowPlayingTracks = queueIds.map((id) => trackMap.get(id)).filter(Boolean) as Track[];
    return [
      { id: "now", name: "正在播放", description: "当前队列", tracks: nowPlayingTracks, kind: "manual" as const, source: null, matchedCount: nowPlayingTracks.length },
      ...playlists.map((playlist) => {
        const result = resolvePlaylistTracks(playlist, tracks, { favoriteTrackIds, activity });
        return {
          id: playlist.id,
          name: playlist.name,
          description: playlist.id === DEFAULT_PLAYLIST_ID
            ? "收藏的歌曲"
            : playlist.description || (isSmartPlaylist(playlist) ? "自动更新的智能播放列表" : "自定义播放列表"),
          tracks: result.tracks,
          kind: isSmartPlaylist(playlist) ? "smart" as const : "manual" as const,
          source: playlist,
          matchedCount: result.matchedCount,
        };
      }),
    ];
  }, [activity, favoriteTrackIds, playlists, queueIds, trackMap, tracks]);
  const selected = entries.find((item) => item.id === selectedPlaylistId) ?? entries[0];

  return (
    <div className="playlist-browser">
      <section className="playlist-list">
        <div className="playlist-create">
          <button className="playlist-create-button" onClick={onCreatePlaylist}>
            <Plus size={18} />
            <span>新建播放列表</span>
          </button>
        </div>
        {entries.map((playlist) => (
          <button
            key={playlist.id}
            className={playlist.id === selected.id ? "selected" : ""}
            onClick={() => onSelectPlaylist(playlist.id)}
            onContextMenu={(event) =>
              onContextMenu(event, {
                kind: "playlist",
                title: playlist.name,
                subtitle: playlist.description,
                tracks: playlist.tracks,
                playlistId: playlist.id,
                playlistKind: playlist.kind,
              })
            }
          >
            <strong>{playlist.name}</strong>
            <span className="playlist-list-description">
              {playlist.kind === "smart" && <Sparkles size={12} />}
              {playlist.description}
            </span>
          </button>
        ))}
      </section>

      <section className="playlist-table">
        <div className="playlist-head">
          <span>#</span>
          <span>歌曲</span>
          <span>艺术家</span>
          <span>专辑</span>
        </div>
        <div className="playlist-rows">
          {selected.tracks.length === 0 ? (
            <p className="quiet">
              {selected.kind === "smart" ? "当前规则没有匹配歌曲，可以编辑条件放宽范围" : "在音乐上点击右键，即可添加到这个播放列表"}
            </p>
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
                    playbackTracks: selected.tracks,
                    playlistId: selected.id,
                    playlistKind: selected.kind,
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
        <div className={`playlist-art ${selected.kind === "smart" ? "smart" : ""}`}>
          {selected.kind === "smart" ? <Sparkles size={42} /> : initials(selected.name)}
        </div>
        <strong>{selected.name}</strong>
        <span>{selected.description}</span>
        <p>{selected.tracks.length} 首歌曲</p>
        {selected.kind === "smart" && <small>从 {selected.matchedCount} 首匹配歌曲中智能编排</small>}
        {selected.tracks.length > 0 && (
          <button className="playlist-detail-play" onClick={() => onPlayTracks(selected.tracks)}>
            <Play size={15} fill="currentColor" /> 播放全部
          </button>
        )}
        {selected.kind === "smart" && selected.source && (
          <div className="playlist-smart-actions">
            <button onClick={() => onEditSmartPlaylist(selected.id)}><SlidersHorizontal size={15} /> 编辑规则</button>
            <button onClick={() => onRefreshSmartPlaylist(selected.id)}><RefreshCw size={15} /> 换一批</button>
          </div>
        )}
      </aside>
    </div>
  );
}
