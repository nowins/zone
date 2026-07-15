import { useMemo } from "react";
import type { MouseEvent } from "react";
import { Play } from "lucide-react";
import { Cover } from "../components/Cover";
import type { AlbumGroup, ContextPayload, Track } from "../types";

function albumForTrack(albums: AlbumGroup[], track: Track | null) {
  if (!track) return albums[0] ?? null;
  return albums.find((album) => album.tracks.some((item) => item.id === track.id)) ?? albums[0] ?? null;
}

export function QuickplayView({
  tracks,
  albums,
  activeTrack,
  historyIds,
  onPlay,
  onPlayTracks,
  onOpenNowPlaying,
  onOpenCollection,
  onContextMenu,
}: {
  tracks: Track[];
  albums: AlbumGroup[];
  activeTrack: Track | null;
  historyIds: string[];
  onPlay: (track: Track, sourceTracks?: Track[]) => void;
  onPlayTracks: (tracks: Track[]) => void;
  onOpenNowPlaying: () => void;
  onOpenCollection: () => void;
  onContextMenu: (event: MouseEvent, payload: ContextPayload) => void;
}) {
  const continueAlbum = albumForTrack(albums, activeTrack);
  const recentAlbums = albums.slice(-6).reverse();
  const historyTracks = useMemo(() => {
    const trackMap = new Map(tracks.map((track) => [track.id, track]));
    const candidates = [
      ...historyIds.map((id) => trackMap.get(id)).filter((track): track is Track => Boolean(track)),
      ...tracks,
    ];
    const seenAlbums = new Set<string>();
    const result: Track[] = [];

    for (const track of candidates) {
      if (track.album === activeTrack?.album || seenAlbums.has(track.album)) continue;
      seenAlbums.add(track.album);
      result.push(track);
      if (result.length === 4) break;
    }

    return result;
  }, [activeTrack?.album, historyIds, tracks]);
  const featuredHistory = historyTracks[0] ?? activeTrack ?? tracks[0] ?? null;
  const compactHistory = historyTracks.filter((track) => track.id !== featuredHistory?.id).slice(0, 3);

  if (tracks.length === 0) {
    return (
      <section className="quickplay quickplay-empty">
        <div>
          <h1>quickplay</h1>
          <button onClick={onOpenCollection}>打开收藏并添加音乐</button>
        </div>
      </section>
    );
  }

  return (
    <section className="quickplay" aria-label="Quickplay">
      <article className="quick-group quick-continue">
        <h2>继续播放</h2>
        {continueAlbum ? (
          <div
            className="quick-feature"
            onContextMenu={(event) =>
              onContextMenu(event, {
                kind: "album",
                title: continueAlbum.album,
                subtitle: continueAlbum.artist,
                tracks: continueAlbum.tracks,
              })
            }
          >
            <button
              className="quick-cover-button"
              onClick={activeTrack ? onOpenNowPlaying : () => onPlayTracks(continueAlbum.tracks)}
              title={activeTrack ? "打开正在播放" : `播放 ${continueAlbum.album}`}
            >
              <Cover
                artPath={activeTrack?.cover_path ?? continueAlbum.coverPath}
                label={activeTrack?.album ?? continueAlbum.album}
                size="large"
              />
              <span className="quick-play-cue"><Play size={25} fill="currentColor" /></span>
            </button>
            <button className="quick-caption" onClick={() => onPlayTracks(continueAlbum.tracks)}>
              <strong>{activeTrack?.title ?? continueAlbum.album}</strong>
              <span>{activeTrack?.artist ?? continueAlbum.artist}</span>
            </button>
          </div>
        ) : null}
      </article>

      <article className="quick-group quick-recent">
        <button className="quick-heading" onClick={onOpenCollection}>
          <h2>最近添加</h2>
        </button>
        <div className="quick-mosaic">
          {recentAlbums.map((album, index) => (
            <div
              className="quick-album"
              key={album.key}
              onContextMenu={(event) =>
                onContextMenu(event, {
                  kind: "album",
                  title: album.album,
                  subtitle: album.artist,
                  tracks: album.tracks,
                })
              }
            >
              <button onClick={() => onPlayTracks(album.tracks)} title={`播放 ${album.album}`}>
                <Cover artPath={album.coverPath} label={album.album} size="large" index={index + 1} />
              </button>
              <strong>{album.album}</strong>
              <span>{album.artist}</span>
            </div>
          ))}
        </div>
      </article>

      <article className="quick-group quick-history">
        <h2>播放历史</h2>
        <div className="history-layout">
          {featuredHistory ? (
            <div
              className="history-feature"
              onContextMenu={(event) =>
                onContextMenu(event, {
                  kind: "track",
                  title: featuredHistory.title,
                  subtitle: `${featuredHistory.artist} / ${featuredHistory.album}`,
                  tracks: [featuredHistory],
                })
              }
            >
              <button onClick={() => onPlay(featuredHistory, tracks)}>
                <Cover artPath={featuredHistory.cover_path} label={featuredHistory.album} size="large" index={5} />
              </button>
              <strong>{featuredHistory.title}</strong>
              <span>{featuredHistory.artist}</span>
            </div>
          ) : null}
          <div className="history-stack">
            {compactHistory.map((track, index) => (
              <button
                key={track.id}
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
                <Cover artPath={track.cover_path} label={track.album} size="large" index={index + 2} />
                <span><strong>{track.title}</strong>{track.artist}</span>
              </button>
            ))}
          </div>
        </div>
      </article>
    </section>
  );
}
