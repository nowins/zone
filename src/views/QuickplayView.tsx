import { useMemo } from "react";
import type { MouseEvent } from "react";
import { Play } from "lucide-react";
import { Button } from "../components/Button";
import { useQuickplayPanorama } from "../hooks/useQuickplayPanorama";
import { Cover } from "../components/Cover";
import { DEFAULT_PLAYLIST_ID } from "../constants";
import { registerFlipElement } from "../motion/flip";
import { useReducedMotion } from "../motion/useReducedMotion";
import { homePinSize } from "../utils/homePins";
import { isSmartPlaylist, resolvePlaylistTracks } from "../utils/smartPlaylist";
import {
  buildQuickplayBlocks,
} from "../utils/quickplayBlocks";
import { pickCoverCandidates } from "../utils/nowPlayingWall";
import { podcastArtworkSrc } from "../utils/podcastArtwork";
import { QuickplayPinBoard, type ResolvedPin } from "../components/tiles/QuickplayPinBoard";
import { tiltPressClear, tiltPressDown } from "../utils/tiltPress";
import type {
  AlbumGroup,
  ArtistGroup,
  ContextPayload,
  HomePin,
  HomePinSize,
  HomePinCustomization,
  Playlist,
  PodcastFeed,
  Track,
  TrackActivityMap,
  ViewMode,
} from "../types";


function coverPathsForTracks(tracks: Track[], limit: number, preferredArtist?: string | null) {
  const preferred = pickCoverCandidates(tracks, limit, preferredArtist);
  if (preferred.length > 0) return preferred;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const track of tracks) {
    if (!track.cover_path || seen.has(track.cover_path)) continue;
    seen.add(track.cover_path);
    result.push(track.cover_path);
    if (result.length === limit) break;
  }
  return result;
}

export function QuickplayView({
  tracks,
  albums,
  artists,
  playlists,
  activeTrack,
  historyIds,
  activity,
  favoriteTrackIds,
  homePins,
  onPlay,
  onPlayTracks,
  onResumePlayback,
  onOpenNowPlaying,
  onOpenCollection,
  onMovePin,
  onShiftPin,
  onResizePin,
  onCustomizePin,
  onTogglePin,
  onContextMenu,
  podcastActive = false,
  podcastFeeds = [],
  onOpenPodcastFeed,
  onTogglePodcastPin,
}: {
  tracks: Track[];
  albums: AlbumGroup[];
  artists: ArtistGroup[];
  playlists: Playlist[];
  activeTrack: Track | null;
  historyIds: string[];
  activity: TrackActivityMap;
  favoriteTrackIds: ReadonlySet<string>;
  homePins: HomePin[];
  onPlay: (track: Track, sourceTracks?: Track[]) => void;
  onPlayTracks: (tracks: Track[]) => void;
  onResumePlayback: () => void;
  onOpenNowPlaying: () => void;
  onOpenCollection: (view: ViewMode) => void;
  onMovePin: (sourceId: string, targetId: string, placeAfter?: boolean) => void;
  onShiftPin: (pinId: string, direction: -1 | 1) => void;
  onResizePin: (pinId: string, size: HomePinSize) => void;
  onCustomizePin: (pinId: string, patch: HomePinCustomization) => void;
  onTogglePin: (payload: ContextPayload) => void;
  onContextMenu: (event: MouseEvent, payload: ContextPayload) => void;
  podcastActive?: boolean;
  podcastFeeds?: PodcastFeed[];
  onOpenPodcastFeed?: (feedId: string) => void;
  onTogglePodcastPin?: (feedId: string) => void;
}) {
  const reducedMotion = useReducedMotion();
  // A podcast owns the shared audio element. Continue must not treat the
  // leftover music track as a live session, or resume would restart the show.
  const musicActiveTrack = podcastActive ? null : activeTrack;
  const blockInput = useMemo(() => ({
    tracks,
    albums,
    playlists,
    activity,
    favoriteTrackIds,
    historyIds,
    activeTrack: musicActiveTrack,
  }), [activity, albums, favoriteTrackIds, historyIds, musicActiveTrack, playlists, tracks]);
  const autoBlocks = useMemo(() => buildQuickplayBlocks(blockInput), [blockInput]);
  const continueBlock = autoBlocks.find((block) => block.id === "continue") ?? null;
  const continueItem = continueBlock?.items[0] ?? null;
  const continueTrack = continueItem?.kind === "track" ? musicActiveTrack : null;
  const continueArtPath = continueTrack?.cover_path ?? continueItem?.artPath ?? null;
  const continueTitle = continueTrack?.title ?? continueItem?.title ?? "";
  const continueSubtitle = continueTrack?.artist ?? continueItem?.subtitle ?? "";
  const recentAlbums = useMemo(() => {
    const items = autoBlocks.find((block) => block.id === "recentAdded")?.items ?? [];
    return items.flatMap((item) => {
      if (item.kind !== "album") return [];
      const album = albums.find((entry) => entry.key === item.id);
      return album ? [album] : [];
    });
  }, [albums, autoBlocks]);
  // Never invent history from the library order — empty history stays empty.
  const historyTracks = useMemo(() => {
    const items = autoBlocks.find((block) => block.id === "history")?.items ?? [];
    return items.flatMap((item) => item.tracks[0] ? [item.tracks[0]] : []);
  }, [autoBlocks]);
  const mostPlayedTracks = useMemo(() => {
    const items = autoBlocks.find((block) => block.id === "mostPlayed")?.items ?? [];
    return items.flatMap((item) => item.tracks[0] ? [item.tracks[0]] : []);
  }, [autoBlocks]);
  const forgottenFavoriteTracks = useMemo(() => {
    const items = autoBlocks.find((block) => block.id === "forgottenFavorites")?.items ?? [];
    return items.flatMap((item) => item.tracks[0] ? [item.tracks[0]] : []);
  }, [autoBlocks]);
  const resolvedPins = useMemo(() => {
    const trackMap = new Map(tracks.map((track) => [track.id, track]));
    const albumMap = new Map(albums.map((album) => [album.key, album]));
    const artistMap = new Map(artists.map((artist) => [artist.artist, artist]));
    const playlistMap = new Map(playlists.map((playlist) => [playlist.id, playlist]));
    const podcastFeedMap = new Map(podcastFeeds.map((feed) => [feed.id, feed]));

    const latestActivityAt = (items: Track[]): number | null => {
      let latest: number | null = null;
      for (const item of items) {
        const at = activity[item.id]?.lastPlayedAt;
        if (at && (!latest || at > latest)) latest = at;
      }
      return latest;
    };

    const liveLineFor = (items: Track[], count: number, fallback: string): string => {
      const latest = latestActivityAt(items);
      const countText = count > 0 ? `${count} 首` : fallback;
      if (!latest) return countText;
      const days = Math.floor((Date.now() - latest) / 86_400_000);
      const when = days <= 0 ? "今天听过" : days === 1 ? "昨天听过" : days < 30 ? `${days} 天前听过` : "很久以前听过";
      return `${countText} · ${when}`;
    };

    return homePins.flatMap<ResolvedPin>((pin) => {
      if (pin.kind === "track") {
        const track = trackMap.get(pin.targetId);
        if (!track) return [];
        const payload: ContextPayload = {
          kind: "track",
          title: track.title,
          subtitle: `${track.artist} / ${track.album}`,
          tracks: [track],
          playbackTracks: tracks,
        };
        return [{
          pin,
          title: track.title,
          subtitle: track.artist,
          tracks: [track],
          artPaths: coverPathsForTracks([track], 1),
          payload,
          size: homePinSize(pin),
          isSmart: false,
          liveLine: liveLineFor([track], 0, track.album),
        }];
      }

      if (pin.kind === "album") {
        const album = albumMap.get(pin.targetId);
        if (!album) return [];
        const payload: ContextPayload = {
          kind: "album",
          title: album.album,
          subtitle: album.artist,
          tracks: album.tracks,
          targetId: album.key,
        };
        return [{
          pin,
          title: album.album,
          subtitle: album.artist,
          tracks: album.tracks,
          artPaths: album.coverPath ? [album.coverPath] : coverPathsForTracks(album.tracks, 1),
          payload,
          size: homePinSize(pin),
          isSmart: false,
          liveLine: liveLineFor(album.tracks, album.tracks.length, "专辑"),
        }];
      }

      if (pin.kind === "artist") {
        const artist = artistMap.get(pin.targetId);
        if (!artist) return [];
        const payload: ContextPayload = {
          kind: "artist",
          title: artist.artist,
          subtitle: `${artist.tracks.length} 首歌曲`,
          tracks: artist.tracks,
        };
        return [{
          pin,
          title: artist.artist,
          subtitle: `${artist.tracks.length} 首歌曲`,
          tracks: artist.tracks,
          artPaths: coverPathsForTracks(artist.tracks, 9, artist.artist),
          payload,
          size: homePinSize(pin),
          isSmart: false,
          liveLine: liveLineFor(artist.tracks, artist.tracks.length, "艺术家"),
        }];
      }

      if (pin.kind === "podcastFeed") {
        const feed = podcastFeedMap.get(pin.targetId);
        if (!feed) return [];
        const updatedDays = feed.latestEpisodeAt
          ? Math.floor((Date.now() - feed.latestEpisodeAt) / 86_400_000)
          : null;
        const podcastRecency = updatedDays === null
          ? ""
          : updatedDays <= 0
            ? "今天更新"
            : updatedDays === 1
              ? "昨天更新"
              : updatedDays < 30
                ? `${updatedDays} 天前更新`
                : "很久以前更新";
        return [{
          pin,
          title: feed.title,
          subtitle: feed.author ?? "播客节目",
          tracks: [],
          artPaths: [],
          payload: null,
          size: homePinSize(pin),
          isSmart: false,
          liveLine: feed.unplayedCount > 0
            ? `${feed.unplayedCount} 集未听`
            : "全部已听完",
          podcastFeed: feed,
          podcastArtwork: podcastArtworkSrc(feed.artworkUrl),
          podcastRecency,
        }];
      }

      const playlist = playlistMap.get(pin.targetId);
      if (!playlist) return [];
      const result = resolvePlaylistTracks(playlist, tracks, { favoriteTrackIds, activity });
      const smart = isSmartPlaylist(playlist);
      const payload: ContextPayload = {
        kind: "playlist",
        title: playlist.name,
        subtitle: playlist.id === DEFAULT_PLAYLIST_ID
          ? "收藏的歌曲"
          : smart
            ? playlist.description
            : `${result.tracks.length} 首歌曲`,
        tracks: result.tracks,
        playlistId: playlist.id,
        playlistKind: smart ? "smart" : "manual",
      };
      return [{
        pin,
        title: playlist.name,
        subtitle: `${result.tracks.length} 首歌曲`,
        tracks: result.tracks,
        artPaths: coverPathsForTracks(result.tracks, 9),
        payload,
        size: homePinSize(pin),
        isSmart: smart,
        liveLine: liveLineFor(result.tracks, result.tracks.length, "歌单"),
      }];
    });
  }, [activity, albums, artists, favoriteTrackIds, homePins, playlists, podcastFeeds, tracks]);
  const empty = tracks.length === 0 && homePins.length === 0;
  const sections = useMemo(() => [
    "pins",
    ...(continueItem ? ["continue"] : []),
    ...(mostPlayedTracks.length ? ["most"] : []),
    ...(forgottenFavoriteTracks.length ? ["forgotten"] : []),
    ...(recentAlbums.length ? ["recent"] : []),
    ...(historyTracks.length ? ["history"] : []),
  ], [Boolean(continueItem), mostPlayedTracks.length > 0, forgottenFavoriteTracks.length > 0, recentAlbums.length > 0, historyTracks.length > 0]);
  const panorama = useQuickplayPanorama(!empty, sections);

  function continueContextPayload(): ContextPayload | null {
    if (!continueItem) return null;
    if (continueItem.kind === "track" && continueTrack) {
      return {
        kind: "track",
        title: continueTrack.title,
        subtitle: `${continueTrack.artist} / ${continueTrack.album}`,
        tracks: [continueTrack],
        playbackTracks: tracks,
      };
    }
    if (continueItem.kind !== "album") return null;
    return {
      kind: "album",
      title: continueItem.title,
      subtitle: continueItem.subtitle,
      tracks: continueItem.tracks,
      targetId: continueItem.id,
    };
  }

  // Cover and caption share one action: resume the live music session, or
  // start the fallback album. Never restart an album just because the
  // current track happens to be its first song.
  function handleContinueActivate(event?: MouseEvent<HTMLButtonElement>) {
    if (!continueItem) return;
    if (continueTrack) {
      onResumePlayback();
      if (!reducedMotion && continueTrack.cover_path && event) {
        const cover = event.currentTarget.querySelector<HTMLElement>(".cover");
        if (cover) registerFlipElement(`cover:${continueTrack.id}`, cover);
      }
      onOpenNowPlaying();
      return;
    }
    if (continueItem.tracks.length > 0) onPlayTracks(continueItem.tracks);
  }

  return (
    <section className={`quickplay ${empty ? "quickplay-empty" : ""}`} onKeyDown={event => {
      if (event.defaultPrevented || (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))) return;
      if (!(event.target instanceof HTMLElement) || !event.target.closest("[data-collection-focus]")) return;
      event.preventDefault();
      const rect = event.target.getBoundingClientRect();
      event.target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 12, clientY: rect.bottom }));
    }}>
      <div className="quickplay-backdrop" ref={panorama.backdropRef} aria-hidden="true" />
      <div className="quickplay-ghost" ref={panorama.titleRef} aria-hidden="true">quickplay</div>
      {empty ? (
        <div className="quickplay-empty-content">
          <button onClick={() => onOpenCollection("albums")}>打开收藏并添加音乐</button>
        </div>
      ) : (<>
        <div
          ref={panorama.viewportRef}
          id="quickplay-viewport"
          className="quickplay-viewport"
          aria-label="快速播放全景"
          tabIndex={0}
          {...panorama.viewportProps}
        >
          <div className="quickplay-track">
        <QuickplayPinBoard
          items={resolvedPins}
          onOpenCollection={() => onOpenCollection("albums")}
          onMovePin={onMovePin}
          onShiftPin={onShiftPin}
          onResizePin={onResizePin}
          onCustomizePin={onCustomizePin}
          onUnpin={(item) => {
            if (item.podcastFeed) onTogglePodcastPin?.(item.pin.targetId);
            else if (item.payload) onTogglePin(item.payload);
          }}
          onContextMenu={(event, item) => {
            if (item.payload) onContextMenu(event, item.payload);
          }}
          onActivate={(item) => {
            if (item.podcastFeed) onOpenPodcastFeed?.(item.pin.targetId);
            else if (item.pin.kind === "track") {
              const track = item.tracks[0];
              if (track) onPlay(track, item.payload?.playbackTracks ?? item.tracks);
            } else onPlayTracks(item.tracks);
          }}
        />

        {continueItem ? (
        <article className="quick-group quick-continue" id="quickplay-continue" data-panorama-section="continue">
          <h2>继续播放</h2>
            <div className="quick-section-scroll">
              <div
                className="quick-feature"
                onContextMenu={(event) => {
                  const payload = continueContextPayload();
                  if (payload) onContextMenu(event, payload);
                }}
              >
              <button
                className="quick-cover-button"
                data-collection-focus="quick-continue"
                onClick={handleContinueActivate}
                title={continueTrack ? `继续播放 ${continueTrack.title}` : `播放 ${continueTitle}`}
              >
                <Cover
                  artPath={continueArtPath}
                  label={continueTitle}
                  size="large"
                />
                <span className="quick-play-cue"><Play size={25} fill="currentColor" /></span>
              </button>
              <button className="quick-caption" data-collection-focus="quick-continue-caption" onClick={() => handleContinueActivate()}>
                <strong>{continueTitle}</strong>
                <span>{continueSubtitle}</span>
              </button>
              </div>
            </div>
        </article>
        ) : null}

        {mostPlayedTracks.length > 0 && (
          <article className="quick-group quick-most" id="quickplay-most" data-panorama-section="most">
            <button className="quick-heading" onClick={() => onOpenCollection("songs")}>
              <h2>最常播放</h2>
            </button>
            <div className="quick-section-scroll">
              <div className="quick-mosaic">
              {mostPlayedTracks.map((track, index) => (
                <div
                  className="quick-album"
                  key={`most-${track.id}`}
                  data-collection-focus={`quick-most:${track.id}`}
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
                  <button
                    onClick={() => onPlay(track, tracks)}
                    onPointerDown={tiltPressDown}
                    onPointerUp={tiltPressClear}
                    onPointerLeave={tiltPressClear}
                    onPointerCancel={tiltPressClear}
                    title={`播放 ${track.title}`}
                  >
                    <Cover artPath={track.cover_path} label={track.album} size="large" index={index + 8} />
                  </button>
                  <strong>{track.title}</strong>
                  <span>{track.artist}</span>
                </div>
              ))}
              </div>
            </div>
          </article>
        )}

        {forgottenFavoriteTracks.length > 0 && (
          <article className="quick-group quick-forgotten" id="quickplay-forgotten" data-panorama-section="forgotten">
            <button className="quick-heading" onClick={() => onOpenCollection("playlists")}>
              <h2>久违收藏</h2>
            </button>
            <div className="quick-section-scroll">
              <div className="quick-mosaic">
              {forgottenFavoriteTracks.map((track, index) => (
                <div
                  className="quick-album"
                  key={`forgotten-${track.id}`}
                  data-collection-focus={`quick-forgotten:${track.id}`}
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
                  <button
                    onClick={() => onPlay(track, tracks)}
                    onPointerDown={tiltPressDown}
                    onPointerUp={tiltPressClear}
                    onPointerLeave={tiltPressClear}
                    onPointerCancel={tiltPressClear}
                    title={`播放 ${track.title}`}
                  >
                    <Cover artPath={track.cover_path} label={track.album} size="large" index={index + 14} />
                  </button>
                  <strong>{track.title}</strong>
                  <span>{track.artist}</span>
                </div>
              ))}
              </div>
            </div>
          </article>
        )}

        {recentAlbums.length > 0 && (<article className="quick-group quick-recent" id="quickplay-recent" data-panorama-section="recent">
          <button className="quick-heading" onClick={() => onOpenCollection("albums")}>
            <h2>最近添加</h2>
          </button>
          <div className="quick-section-scroll">
            <div className="quick-mosaic">
            {recentAlbums.map((album, index) => (
              <div
                className="quick-album"
                key={album.key}
                data-collection-focus={`quick-recent:${album.key}`}
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
                <button
                  onClick={() => onPlayTracks(album.tracks)}
                  onPointerDown={tiltPressDown}
                  onPointerUp={tiltPressClear}
                  onPointerLeave={tiltPressClear}
                  onPointerCancel={tiltPressClear}
                  title={`播放 ${album.album}`}
                >
                  <Cover artPath={album.coverPath} label={album.album} size="large" index={index + 1} />
                </button>
                <strong>{album.album}</strong>
              <span>{album.artist}</span>
            </div>
            ))}
            </div>
          </div>
        </article>)}

        {historyTracks.length > 0 && (
          <article className="quick-group quick-history" id="quickplay-history" data-panorama-section="history">
            <button className="quick-heading" onClick={() => onOpenCollection("songs")}>
              <h2>播放历史</h2>
            </button>
            <div className="quick-section-scroll">
              <ol className="quick-history-list">
                {historyTracks.map((track, index) => (
                  <li key={track.id}>
                  <Button variant="ghost" className="quick-history-row"
                    data-collection-focus={`quick-history:${track.id}`}
                    onClick={() => onPlay(track, tracks)}
                    aria-label={`播放 ${track.title} · ${track.artist}`}
                    title={`${track.title}\n${track.artist}`}
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
                    <Cover artPath={track.cover_path} label={track.album} size="large" index={index + 2} />
                    <span className="quick-history-copy"><strong>{track.title}</strong><span>{track.artist}</span></span>
                  </Button>
                  </li>
                ))}
              </ol>
            </div>
          </article>
        )}
          </div>
        </div>
        <input ref={panorama.scrollbarRef} className="quick-panorama-scrollbar" type="range"
          min={0} step="any" defaultValue={0} disabled={!panorama.overflow}
          aria-label="首页横向滚动" aria-controls="quickplay-viewport" aria-hidden={!panorama.overflow}
          {...panorama.scrollbarProps} />
      </>)}
    </section>
  );
}
