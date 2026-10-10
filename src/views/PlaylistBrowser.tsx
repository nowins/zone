import { useMemo, useRef } from "react";
import type { MouseEvent } from "react";
import { Heart, ListMusic, MoreHorizontal, Play, Plus, RefreshCw, SlidersHorizontal, Sparkles } from "lucide-react";
import { DEFAULT_PLAYLIST_ID } from "../constants";
import { Button } from "../components/Button";
import { Cover } from "../components/Cover";
import { CollectionTrackList } from "../components/CollectionTrackList";
import { useCollectionPanelMotion } from "../hooks/useCollectionPivot";
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
  onToggleFavorite,
  activity,
  onReorderPlaylist,
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
  onToggleFavorite: (track: Track) => void;
  activity: TrackActivityMap;
  onReorderPlaylist?: (playlistId: string, trackId: string, targetId: string) => void;
}) {
  const trackMap = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);
  const entries = useMemo(() => {
    const nowPlayingTracks = queueIds.map((id) => trackMap.get(id)).filter(Boolean) as Track[];
    return [
      { id: "now", name: "正在播放", description: "当前队列", tracks: nowPlayingTracks, kind: "manual" as const, source: null, matchedCount: nowPlayingTracks.length },
      ...playlists.map((playlist) => {
        const result = resolvePlaylistTracks(playlist, tracks, { favoriteTrackIds, activity });
        const smart = isSmartPlaylist(playlist);
        const isCustomManual = !smart && playlist.id !== DEFAULT_PLAYLIST_ID;
        const playlistDescription = playlist.id === DEFAULT_PLAYLIST_ID
          ? `${result.tracks.length} 首喜欢的歌曲`
          : playlist.description || (smart ? "自动更新的智能播放列表" : "自定义播放列表");
        return {
          id: playlist.id,
          name: playlist.id === DEFAULT_PLAYLIST_ID ? "喜欢的歌曲" : playlist.name,
          description: isCustomManual ? `${result.tracks.length} 首歌曲` : playlistDescription,
          tracks: result.tracks,
          kind: smart ? "smart" as const : "manual" as const,
          source: playlist,
          matchedCount: result.matchedCount,
        };
      }),
    ];
  }, [activity, favoriteTrackIds, playlists, queueIds, trackMap, tracks]);
  const selected = entries.find((item) => item.id === selectedPlaylistId);
  const contentRef = useRef<HTMLElement>(null);
  useCollectionPanelMotion(contentRef, selectedPlaylistId);
  if (!selected) return <div className="collection-unavailable"><h2>此播放列表已不存在</h2>
    <Button onClick={() => onSelectPlaylist(DEFAULT_PLAYLIST_ID)}>查看喜欢的歌曲</Button></div>;
  const artwork = [...new Set(selected.tracks.flatMap((track) => track.cover_path ? [track.cover_path] : []))].slice(0, 4);
  const covers = artwork.length === 4 ? artwork : artwork.slice(0, 1);
  const duration = selected.tracks.reduce((total, track) => total + (track.duration_seconds ?? 0), 0);
  const hasDuration = selected.tracks.length > 0 && selected.tracks.every((track) => Number.isFinite(track.duration_seconds) && (track.duration_seconds ?? 0) > 0);
  const fallback = selected.id === DEFAULT_PLAYLIST_ID ? <Heart size={28} />
    : selected.kind === "smart" ? <Sparkles size={28} /> : <ListMusic size={28} />;

  return (
    <div className="playlist-browser">
      <section className="playlist-list" aria-label="播放列表" data-collection-scroll="playlist-index">
        <div className="playlist-create">
          <Button className="playlist-create-button" variant="ghost" size="sm" icon={<Plus size={16} />} onClick={onCreatePlaylist}>新建播放列表</Button>
        </div>
        {entries.map((playlist) => (
          <button
            key={playlist.id}
            data-collection-anchor={playlist.id} data-collection-focus={`playlist:${playlist.id}`}
            className={playlist.id === selected.id ? "selected" : ""}
            aria-pressed={playlist.id === selected.id}
            title={playlist.name} data-touch-menu
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

      <section ref={contentRef} className="playlist-content" aria-label={selected.name}>
        <div className="playlist-detail">
        <header className="playlist-heading">
          <div className="playlist-cover-grid" data-count={covers.length === 4 ? 4 : 1} aria-hidden="true">
            {covers.length > 0 ? covers.map((path) => <Cover key={path} artPath={path} label={selected.name} fallback={fallback} />)
              : <Cover label={selected.name} fallback={fallback} />}
          </div>
          <div className="playlist-heading-copy">
            <h2 title={selected.name}>{selected.name}</h2>
            <p>{selected.tracks.length} 首歌曲{hasDuration ? ` · ${Math.ceil(duration / 60)} 分钟` : ""}</p>
            {selected.kind === "smart" && <p className="playlist-matches">从 {selected.matchedCount} 首匹配歌曲中智能编排</p>}
            {selected.id !== DEFAULT_PLAYLIST_ID && selected.source?.description && <p className="playlist-description" title={selected.source.description}>{selected.source.description}</p>}
          </div>
          <div className="playlist-header-actions">
            <Button size="sm" icon={<Play size={14} fill="currentColor" />} disabled={selected.tracks.length === 0}
              onClick={() => onPlayTracks(selected.tracks)}>播放全部</Button>
            {selected.kind === "smart" && selected.source && <>
              <Button variant="ghost" size="sm" icon={<SlidersHorizontal size={14} />} onClick={() => onEditSmartPlaylist(selected.id)}>编辑规则</Button>
              <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => onRefreshSmartPlaylist(selected.id)}>换一批</Button>
            </>}
            <Button size="sm" variant="ghost" icon={<MoreHorizontal size={18} />} aria-label={`${selected.name}的更多操作`}
              onClick={event => onContextMenu(event, { kind: "playlist", title: selected.name, subtitle: selected.description,
                tracks: selected.tracks, playlistId: selected.id, playlistKind: selected.kind })}>更多</Button>
          </div>
        </header>
        <CollectionTrackList key={selected.id} listKey={`playlist:${selected.id}`} tracks={selected.tracks} activeTrackId={activeTrackId}
          onReorder={onReorderPlaylist && selected.source && selected.kind === "manual" && selected.id !== DEFAULT_PLAYLIST_ID
            ? (trackId, targetId) => onReorderPlaylist(selected.id, trackId, targetId) : undefined}
          onPlay={onPlay} favoriteTrackIds={favoriteTrackIds} onToggleFavorite={onToggleFavorite}
          emptyText={selected.kind === "smart" ? "暂无匹配歌曲" : "暂无歌曲"}
          onContextMenu={(event, track) => onContextMenu(event, {
            kind: "track", title: track.title, subtitle: `${track.artist} / ${track.album}`,
            tracks: [track], playbackTracks: selected.tracks, playlistId: selected.id, playlistKind: selected.kind,
          })} />
        </div>
      </section>
    </div>
  );
}
