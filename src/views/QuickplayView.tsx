import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { GripVertical, Pin, PinOff, Play, Sparkles } from "lucide-react";
import { Cover } from "../components/Cover";
import { DEFAULT_PLAYLIST_ID } from "../constants";
import { animateValue } from "../motion/animate";
import type { AnimationHandle } from "../motion/animate";
import { registerFlipElement } from "../motion/flip";
import { SPRING_PRESETS } from "../motion/tokens";
import { useReducedMotion } from "../motion/useReducedMotion";
import { isSmartPlaylist, resolvePlaylistTracks } from "../utils/smartPlaylist";
import {
  buildForgottenFavoritesBlock,
  buildHistoryBlock,
  buildMostPlayedBlock,
  buildRecentAddedBlock,
} from "../utils/quickplayBlocks";
import { pickCoverCandidates } from "../utils/nowPlayingWall";
import { FlipTile } from "../components/tiles";
import { tiltPressClear, tiltPressDown } from "../utils/tiltPress";
import type {
  AlbumGroup,
  ArtistGroup,
  ContextPayload,
  HomePin,
  Playlist,
  Track,
  TrackActivityMap,
  ViewMode,
} from "../types";

type ResolvedPin = {
  pin: HomePin;
  title: string;
  subtitle: string;
  tracks: Track[];
  artPaths: string[];
  payload: ContextPayload;
  isWide: boolean;
  isSmart: boolean;
};

let quickplayScrollPosition = 0;

function albumForTrack(albums: AlbumGroup[], track: Track | null) {
  if (!track) return albums[0] ?? null;
  return albums.find((album) => album.tracks.some((item) => item.id === track.id)) ?? albums[0] ?? null;
}

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
  onOpenNowPlaying,
  onOpenCollection,
  onOpenPin,
  onMovePin,
  onShiftPin,
  onTogglePin,
  onContextMenu,
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
  onOpenNowPlaying: () => void;
  onOpenCollection: (view: ViewMode) => void;
  onOpenPin: (pin: HomePin) => void;
  onMovePin: (sourceId: string, targetId: string) => void;
  onShiftPin: (pinId: string, direction: -1 | 1) => void;
  onTogglePin: (payload: ContextPayload) => void;
  onContextMenu: (event: MouseEvent, payload: ContextPayload) => void;
}) {
  const viewportRef = useRef<HTMLElement | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const scrollAnimRef = useRef<{ target: number | null; handle: AnimationHandle | null }>({
    target: null,
    handle: null,
  });
  const [editingPins, setEditingPins] = useState(false);
  const [draggedPinId, setDraggedPinId] = useState<string | null>(null);
  const pinsGridRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useReducedMotion();
  const continueAlbum = albumForTrack(albums, activeTrack);
  const blockInput = useMemo(() => ({
    tracks,
    albums,
    playlists,
    activity,
    favoriteTrackIds,
    historyIds,
    activeTrack,
  }), [activeTrack, activity, albums, favoriteTrackIds, historyIds, playlists, tracks]);
  const recentAlbums = useMemo(() => {
    const items = buildRecentAddedBlock(blockInput).items;
    return items.flatMap((item) => {
      if (item.kind !== "album") return [];
      const album = albums.find((entry) => entry.key === item.id);
      return album ? [album] : [];
    });
  }, [albums, blockInput]);
  const historyTracks = useMemo(() => {
    return buildHistoryBlock(blockInput).items.flatMap((item) => item.tracks[0] ? [item.tracks[0]] : []);
  }, [blockInput]);
  const mostPlayedTracks = useMemo(() => {
    return buildMostPlayedBlock(blockInput).items.flatMap((item) => item.tracks[0] ? [item.tracks[0]] : []);
  }, [blockInput]);
  const forgottenFavoriteTracks = useMemo(() => {
    return buildForgottenFavoritesBlock(blockInput).items.flatMap((item) => item.tracks[0] ? [item.tracks[0]] : []);
  }, [blockInput]);
  const resolvedPins = useMemo(() => {
    const trackMap = new Map(tracks.map((track) => [track.id, track]));
    const albumMap = new Map(albums.map((album) => [album.key, album]));
    const artistMap = new Map(artists.map((artist) => [artist.artist, artist]));
    const playlistMap = new Map(playlists.map((playlist) => [playlist.id, playlist]));

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
          isWide: false,
          isSmart: false,
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
        };
        return [{
          pin,
          title: album.album,
          subtitle: album.artist,
          tracks: album.tracks,
          artPaths: album.coverPath ? [album.coverPath] : coverPathsForTracks(album.tracks, 1),
          payload,
          isWide: false,
          isSmart: false,
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
          artPaths: coverPathsForTracks(artist.tracks, 4, artist.artist),
          payload,
          isWide: true,
          isSmart: false,
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
        artPaths: coverPathsForTracks(result.tracks, 4),
        payload,
        isWide: true,
        isSmart: smart,
      }];
    });
  }, [activity, albums, artists, favoriteTrackIds, homePins, playlists, tracks]);
  const featuredHistory = historyTracks[0] ?? activeTrack ?? tracks[0] ?? null;
  const compactHistory = historyTracks.filter((track) => track.id !== featuredHistory?.id).slice(0, 3);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollLeft = quickplayScrollPosition;
    handleScroll();
  }, [tracks.length]);

  useEffect(() => {
    if (resolvedPins.length === 0) setEditingPins(false);
  }, [resolvedPins.length]);

  // Play the staggered tile entrance once when the pins first mount, then
  // release the class so re-renders/drag/edit don't replay the reveal.
  useEffect(() => {
    const grid = pinsGridRef.current;
    if (!grid) return undefined;
    grid.classList.add("tiles-enter");
    const timer = window.setTimeout(() => grid.classList.remove("tiles-enter"), 900);
    return () => {
      window.clearTimeout(timer);
      grid.classList.remove("tiles-enter");
    };
  }, [resolvedPins.length > 0]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleWheel = (event: WheelEvent) => {
      const eventTarget = event.target;
      const viewportBounds = viewport.getBoundingClientRect();
      const isWithinViewport = event.clientX >= viewportBounds.left
        && event.clientX <= viewportBounds.right
        && event.clientY >= viewportBounds.top
        && event.clientY <= viewportBounds.bottom;
      const comesFromViewport = eventTarget instanceof Node && viewport.contains(eventTarget);
      if (!comesFromViewport && !isWithinViewport) return;
      const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
      if (maxScrollLeft <= 1) return;

      const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? viewport.clientWidth : 1;
      const deltaX = event.deltaX * unit;
      const legacyWheelDelta = (event as WheelEvent & { wheelDelta?: number }).wheelDelta ?? 0;
      const deltaY = (event.deltaY || -legacyWheelDelta) * unit;
      const delta = Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX;
      if (!delta) return;

      // Wheel pans run through the motion kernel's spring so the panorama
      // decelerates with WP7-like inertia; consecutive ticks retarget the
      // in-flight spring, carrying its velocity instead of restarting. The
      // near-critical snappy preset keeps tracking tight (a softer spring
      // lags noticeably behind fast wheel input).
      const base = scrollAnimRef.current.handle
        ? (scrollAnimRef.current.target ?? viewport.scrollLeft)
        : viewport.scrollLeft;
      const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, base + delta));
      if (nextScrollLeft === base) return;
      event.preventDefault();
      if (reducedMotion) {
        scrollAnimRef.current.handle?.cancel();
        scrollAnimRef.current.handle = null;
        scrollAnimRef.current.target = null;
        viewport.scrollLeft = nextScrollLeft;
        return;
      }
      scrollAnimRef.current.target = nextScrollLeft;
      const running = scrollAnimRef.current.handle;
      if (running) {
        running.retarget(nextScrollLeft);
      } else {
        scrollAnimRef.current.handle = animateValue({
          from: viewport.scrollLeft,
          to: nextScrollLeft,
          spring: SPRING_PRESETS.snappy,
          onUpdate: (value) => {
            viewport.scrollLeft = value;
          },
          onComplete: () => {
            scrollAnimRef.current.handle = null;
          },
        });
      }
    };

    window.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => {
      window.removeEventListener("wheel", handleWheel, true);
      scrollAnimRef.current.handle?.cancel();
      scrollAnimRef.current.handle = null;
      scrollAnimRef.current.target = null;
    };
  }, [tracks.length, reducedMotion]);

  function handleScroll() {
    const viewport = viewportRef.current;
    const ghost = ghostRef.current;
    if (!viewport || !ghost) return;
    quickplayScrollPosition = viewport.scrollLeft;
    ghost.style.transform = `translate3d(${viewport.scrollLeft * 0.72}px, 0, 0)`;
  }

  function handlePanoramaKey(event: KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return;
    const viewport = event.currentTarget;
    // Keyboard paging owns the scroll position now; stop any in-flight
    // wheel-inertia spring so the two never fight over scrollLeft.
    scrollAnimRef.current.handle?.cancel();
    scrollAnimRef.current.handle = null;
    scrollAnimRef.current.target = null;
    const step = Math.max(320, viewport.clientWidth * 0.72);
    const behavior = reducedMotion ? "auto" : "smooth";
    if (event.key === "ArrowRight" || event.key === "PageDown") {
      viewport.scrollBy({ left: step, behavior });
      event.preventDefault();
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      viewport.scrollBy({ left: -step, behavior });
      event.preventDefault();
    } else if (event.key === "Home") {
      viewport.scrollTo({ left: 0, behavior });
      event.preventDefault();
    } else if (event.key === "End") {
      viewport.scrollTo({ left: viewport.scrollWidth, behavior });
      event.preventDefault();
    }
  }

  function handlePinKey(event: KeyboardEvent<HTMLButtonElement>, pinId: string) {
    if (!editingPins || !event.altKey) return;
    if (event.key === "ArrowLeft") {
      onShiftPin(pinId, -1);
      event.preventDefault();
    } else if (event.key === "ArrowRight") {
      onShiftPin(pinId, 1);
      event.preventDefault();
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>, targetId: string) {
    if (!editingPins) return;
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain") || draggedPinId;
    if (sourceId) onMovePin(sourceId, targetId);
    setDraggedPinId(null);
  }

  // The continue-feature cover shows the active track's art and opens now
  // playing, so it doubles as a shared-element source for the cover flight.
  function handleFeatureCoverClick(event: MouseEvent<HTMLButtonElement>) {
    if (!activeTrack) {
      if (continueAlbum) onPlayTracks(continueAlbum.tracks);
      return;
    }
    if (!reducedMotion && activeTrack.cover_path) {
      const cover = event.currentTarget.querySelector<HTMLElement>(".cover");
      if (cover) registerFlipElement(`cover:${activeTrack.id}`, cover);
    }
    onOpenNowPlaying();
  }

  if (tracks.length === 0) {
    return (
      <section className="quickplay quickplay-empty">
        <div>
          <h1>quickplay</h1>
          <button onClick={() => onOpenCollection("albums")}>打开收藏并添加音乐</button>
        </div>
      </section>
    );
  }

  return (
    <section
      ref={viewportRef}
      className="quickplay"
      aria-label="快速播放全景"
      tabIndex={0}
      onScroll={handleScroll}
      onKeyDown={handlePanoramaKey}
    >
      <div className="quickplay-track">
        <div ref={ghostRef} className="quickplay-ghost" aria-hidden="true">quickplay</div>

        <article className="quick-group quick-pins">
          <div className="quick-section-title quick-pins-title">
            <h2>pins</h2>
            {resolvedPins.length > 0 && (
              <button
                className="quick-pins-edit"
                aria-pressed={editingPins}
                onClick={() => setEditingPins((value) => !value)}
              >
                {editingPins ? "完成" : "编辑"}
              </button>
            )}
          </div>
          {resolvedPins.length === 0 ? (
            <button className="quick-pins-empty" onClick={() => onOpenCollection("albums")}>
              <Pin size={22} />
              <span>固定音乐到这里</span>
            </button>
          ) : (
            <div ref={pinsGridRef} className={`quick-pins-grid ${editingPins ? "editing" : ""}`}>
              {resolvedPins.map((item, index) => (
                <article
                  className={`quick-pin ${item.isWide ? "wide" : "square"} ${draggedPinId === item.pin.id ? "dragging" : ""}`}
                  key={item.pin.id}
                  style={{ "--tile-stagger-delay": `${Math.min(index * 46, 460)}ms` } as CSSProperties}
                  draggable={editingPins}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", item.pin.id);
                    setDraggedPinId(item.pin.id);
                  }}
                  onDragEnd={() => setDraggedPinId(null)}
                  onDragOver={(event) => {
                    if (editingPins) event.preventDefault();
                  }}
                  onDrop={(event) => handleDrop(event, item.pin.id)}
                  onContextMenu={(event) => onContextMenu(event, item.payload)}
                >
                  <FlipTile
                    size={item.isWide ? "wide" : "medium"}
                    className="quick-pin-tile"
                    glass
                    title={`打开 ${item.title}`}
                    paused={editingPins}
                    disabled={editingPins}
                    onPress={() => {
                      if (!editingPins) onOpenPin(item.pin);
                    }}
                    onKeyDown={(event) => handlePinKey(event, item.pin.id)}
                    onContextMenu={(event) => onContextMenu(event, item.payload)}
                      front={
                        <>
                          <span className="tile-face-art">
                            <PinArtwork item={item} index={index} />
                          </span>
                        </>
                      }
                      back={
                        <>
                          <span className="tile-back-kicker">{item.isSmart ? "智能" : "已固定"}</span>
                          <strong>{item.title}</strong>
                          <small>{item.subtitle}</small>
                          {item.tracks.length > 0 && (
                            <span className="tile-back-action">
                              <Play size={14} fill="currentColor" aria-hidden="true" />
                              <span>{item.tracks.length} 首</span>
                            </span>
                          )}
                        </>
                      }
                    />
                  {editingPins && (
                    <div className="quick-pin-edit-tools">
                      <GripVertical size={17} aria-hidden="true" />
                      <button onClick={() => onTogglePin(item.payload)} title={`取消固定 ${item.title}`}>
                        <PinOff size={17} />
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </article>

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
                onClick={handleFeatureCoverClick}
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

        {mostPlayedTracks.length > 0 && (
          <article className="quick-group quick-most">
            <button className="quick-heading" onClick={() => onOpenCollection("songs")}>
              <h2>最常播放</h2>
            </button>
            <div className="quick-mosaic">
              {mostPlayedTracks.map((track, index) => (
                <div
                  className="quick-album"
                  key={`most-${track.id}`}
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
          </article>
        )}

        {forgottenFavoriteTracks.length > 0 && (
          <article className="quick-group quick-forgotten">
            <button className="quick-heading" onClick={() => onOpenCollection("playlists")}>
              <h2>久违收藏</h2>
            </button>
            <div className="quick-mosaic">
              {forgottenFavoriteTracks.map((track, index) => (
                <div
                  className="quick-album"
                  key={`forgotten-${track.id}`}
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
          </article>
        )}

        <article className="quick-group quick-recent">
          <button className="quick-heading" onClick={() => onOpenCollection("albums")}>
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
        </article>

        <article className="quick-group quick-history">
          <button className="quick-heading" onClick={() => onOpenCollection("songs")}>
            <h2>播放历史</h2>
          </button>
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
                    playbackTracks: tracks,
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
                  onPointerDown={tiltPressDown}
                  onPointerUp={tiltPressClear}
                  onPointerLeave={tiltPressClear}
                  onPointerCancel={tiltPressClear}
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
                  <span><strong>{track.title}</strong>{track.artist}</span>
                </button>
              ))}
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}

function PinArtwork({ item, index }: { item: ResolvedPin; index: number }) {
  if (item.artPaths.length <= 1) {
    return (
      <div className="quick-pin-art">
        <Cover artPath={item.artPaths[0]} label={item.title} size="large" index={index} />
        {item.isSmart && <Sparkles className="quick-pin-smart" size={21} aria-hidden="true" />}
      </div>
    );
  }

  return (
    <div className={`quick-pin-art quick-pin-collage count-${Math.min(4, item.artPaths.length)}`}>
      {item.artPaths.slice(0, 4).map((artPath, artIndex) => (
        <Cover key={artPath} artPath={artPath} label={item.title} size="large" index={index + artIndex} />
      ))}
      {item.isSmart && <Sparkles className="quick-pin-smart" size={21} aria-hidden="true" />}
    </div>
  );
}
