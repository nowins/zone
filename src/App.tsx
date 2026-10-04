import { recordDiagnostic } from "./utils/diagnostics";
import { Button } from "./components/Button";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MetroLoader } from "./components/MetroLoader";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Titlebar } from "./components/Titlebar";
import { CompactPlayerView } from "./views/CompactPlayerView";
import { useCompactMode } from "./hooks/useCompactMode";
import { useNativeWindowVisibility } from "./hooks/useNativeWindowVisibility";
import { AppHeader } from "./components/AppHeader";
import { PlayerBar } from "./components/PlayerBar";
import { AudioGlowCanvas } from "./components/AudioGlowCanvas";
import { PodcastPlayerBar } from "./components/PodcastPlayerBar";
import { ContextMenu } from "./components/ContextMenu";
import { InfoPanel } from "./components/InfoPanel";
import { isSmartPlaylist } from "./utils/smartPlaylist";
import { AddToPlaylistDialog } from "./components/AddToPlaylistDialog";
import { PlaylistDialog, type PlaylistDialogState } from "./components/PlaylistDialog";
import { SmartPlaylistDialog } from "./components/SmartPlaylistDialog";
import { QuickplayView } from "./views/QuickplayView";
import { NowPlayingView } from "./views/NowPlayingView";
import { PodcastNowPlayingView } from "./views/PodcastNowPlayingView";
import { DEFAULT_PLAYLIST_ID, LIBRARY_SCHEMA_VERSION, STORAGE_KEY } from "./constants";
import { migrateLegacyState } from "./utils/legacyMigration";
import { useMountedRef } from "./hooks/useMountedRef";
import {
  musicClearLibrary,
  musicGetLibrarySnapshot,
  musicImportLegacyPlayerState,
  musicSaveHomePins,
  musicSavePlaybackState,
  musicSavePlaylists,
  musicSaveTrackActivity,
  musicAnalyzeFeatures,
  musicListTrackFeatures,
  musicGetRadioSession,
} from "./app/musicLibraryApi";
import { normalizePlaylists } from "./utils/music";
import { seedFromTracks } from "./utils/smartDj";
import { customizeHomePin, homePinStateForPayload, moveHomePin, normalizeHomePins, setHomePinSize, shiftHomePin } from "./utils/homePins";
import { useSystemMedia } from "./hooks/useSystemMedia";
import { useAppHotkeys } from "./hooks/useAppHotkeys";
import { CollectionView } from "./views/CollectionView";
import { referenceForPayload, albumReference, artistReference, sameCollectionEntity, type CollectionEntityRef } from "./utils/collectionEntities";
import { useNavigation, type NowPlayingTargets } from "./hooks/useNavigation";
import { useMusicLibrary } from "./hooks/useMusicLibrary";
import { useMetadataEnrichment } from "./hooks/useMetadataEnrichment";
import { usePodcastPlayback } from "./hooks/usePodcastPlayback";
import {
  usePlaybackControls,
  type PlaybackControlsHandle,
  type PlaybackSession,
} from "./hooks/usePlaybackControls";
import { useAudioEngine, type AudioEngineHandle } from "./hooks/useAudioEngine";
import { usePlaylists } from "./hooks/usePlaylists";
import { Presence, useLastNonNull } from "./motion/presence";
import { MOTION_DURATIONS } from "./motion/tokens";
import type {
  ContextMenuState,
  ContextPayload,
  PodcastFeed,
  PodcastRefreshReport,
  SmartPlaylist,
  Track,
} from "./types";
import type { PodcastFeedRequest } from "./views/podcast/types";

// Pinned podcast tiles must stay live without opening the podcast page:
// entering quickplay reloads the local snapshot, and a conditional RSS
// refresh (cheap 304s) pulls new episodes — throttled on re-entry, plus a
// slow poll while the home page stays open.
const PODCAST_TILE_REFRESH_MIN_GAP_MS = 2 * 60_000;
const PODCAST_TILE_REFRESH_INTERVAL_MS = 10 * 60_000;
let lastPodcastTileRefreshAt = 0;

const SettingsView = lazy(() => import("./views/SettingsView").then(module => ({ default: module.SettingsView })));
const PodcastView = lazy(() => import("./views/PodcastView").then(module => ({ default: module.PodcastView })));
const loadingPage = <div role="status" aria-label="正在加载"><MetroLoader /></div>;

export default function App() {
  useNativeWindowVisibility();
  const compactMode = useCompactMode();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackSessionRef = useRef<PlaybackSession | null>(null);
  const playbackControlsRef = useRef<PlaybackControlsHandle | null>(null);
  const audioEngineRef = useRef<AudioEngineHandle | null>(null);
  const nowPlayingTargetsRef = useRef<NowPlayingTargets>({
    activePodcastEpisode: null,
    activeTrack: null,
  });
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const [podcastQueueRequest,setPodcastQueueRequest]=useState(0);
  const podcastQueueRequestNonce=useRef(0);
  const [queue, setQueue] = useState<string[]>([]);
  const [playHistory, setPlayHistory] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [infoTarget, setInfoTarget] = useState<ContextPayload | null>(null);
  const [addToPlaylistTarget, setAddToPlaylistTarget] = useState<ContextPayload | null>(null);
  const [playlistDialog, setPlaylistDialog] = useState<PlaylistDialogState | null>(null);
  const [smartPlaylistDialog, setSmartPlaylistDialog] = useState<SmartPlaylist | "create" | null>(null);
  const [persistenceFailed, setPersistenceFailed] = useState(false);
  const [retryingPersistence, setRetryingPersistence] = useState(false);
  const [clearingLibrary, setClearingLibrary] = useState(false);
  const clearingLibraryRef = useRef(false);
  const pendingMusicWritesRef = useRef(new Set<Promise<unknown>>());
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [featureVectors, setFeatureVectors] = useState<Record<string, number[]>>({});
  const actionNoticeTimerRef = useRef<number | null>(null);

  function showActionNotice(message: string) {
    setActionNotice(message);
    if (actionNoticeTimerRef.current) window.clearTimeout(actionNoticeTimerRef.current);
    actionNoticeTimerRef.current = window.setTimeout(() => {
      setActionNotice(null);
      actionNoticeTimerRef.current = null;
    }, 2_400);
  }

  function trackMusicWrite<T>(write: Promise<T>): Promise<T> {
    pendingMusicWritesRef.current.add(write);
    return write.finally(() => { pendingMusicWritesRef.current.delete(write); });
  }

  const {
    collection,
    selectedPlaylistId,
    setSelectedPlaylistId,
    openCollectionEntity,
    travelCollection,
    searchInputRef,
    view,
    page,
    navDir,
    navDrift,
    navigationAnimated,
    workspaceRef,
    quickplayEntrance,
    previousPageRef,
    requestNavigation,
    clearCollectionSearch,
    setCollectionSearchQuery,
    navigatePage,
    navigateCollection,
    openNowPlaying,
  } = useNavigation({
    shortcutsEnabled: !compactMode.active,
    contextMenu,
    infoTarget,
    addToPlaylistTarget,
    playlistDialog,
    smartPlaylistDialog,
    nowPlayingTargetsRef,
  });
  const {
    folders,
    setFolders,
    tracks,
    setTracks,
    isScanning,
    cancelScan,
    scanNote,
    setScanNote,
    restored,
    setRestored,
    needsMetadataRefresh,
    setNeedsMetadataRefresh,
    trackActivity,
    setTrackActivity,
    activityMigrationRef,
    collectionIndex,
    albums,
    artists,
    addFolder,
    rescan,
  } = useMusicLibrary({ setQueue });
  const metadata = useMetadataEnrichment({
    tracks,
    setTracks,
    restored,
  });
  const podcast = usePodcastPlayback({
    audioRef,
    showActionNotice,
    requestNavigation,
    playbackControlsRef,
    playbackSessionRef,
  });
  const {
    transport: podcastTransport,
    activePodcastEpisode,
    podcastQueue,
    podcastLibraryRevision,
    podcastEpisodeRequest,
    podcastPlaybackRate,
    setPodcastPlaybackRate,
    podcastAutoQueueMode,
    podcastSleepTimer,
    setPodcastSleepTimer,
    podcastPlaybackStatus,
    podcastSessionHydrated,
    playPodcastEpisode,
    playPodcastPlaylist,
    queuePodcastEpisode,
    removePodcastQueueEpisode,
    removePodcastQueueEpisodes,
    clearPodcastQueue,
    movePodcastQueueEpisode,
    reorderPodcastQueueEpisode,
    updatePodcastEpisode,
    reconcileDeletedPodcastDownloads,
    toggleActivePodcastSaved,
    setPodcastEpisodePlayed,
    setPodcastQueueEpisodesPlayed,
    downloadPodcastQueueEpisodes,
    changePodcastAutoQueueMode,
    openActivePodcastEpisode,
    playPodcastQueueEpisodeById,
    markPodcastPlaying,
    resolvePodcastEpisodeRequest,
    playNextPodcastEpisode,
    flushPodcastProgress,
  } = podcast;
  const {
    isPlaying,
    setIsPlaying,
    progress,
    duration,
    volume,
    setVolume,
    shuffle,
    setShuffle,
    repeat,
    setRepeat,
    activeTrack,
    activePlayback,
    activePlaybackSourceKey,
    playbackQueueIds,
    canMovePrevious,
    canMoveNext,
    playTrack,
    playTracks,
    appendToQueue,
    playNext,
    startSmartDj,
    restoreSmartDjSession,
    restoreMusicPosition,
    getMusicPosition,
    dislikeSmartDjTrack,
    getIsSmartDjActive,
    queueInsertMode,
    adaptivePrevious,
    closeToTray,
    updatePlaybackBehavior,
    handleTimeUpdate,
    move,
    onEnded,
    seek,
    handleLoadedMetadata,
    handleAudioPause,
    handleAudioError,
    handleAudioLoadStart,
    handleAudioWaiting,
    handleAudioCanPlay,
    pausePlayback,
    togglePlay,
    retryPodcastPlayback,
    armPodcastPlay,
    clearPlaybackIntent,
    setPlaybackIntent,
    clearPendingPodcastStart,
    peekPendingResumePosition,
    hasEpisodeStartedOnDevice,
  } = usePlaybackControls({
    audioRef,
    showActionNotice,
    audioEngineRef,
    playbackSessionRef,
    tracks,
    restored,
    setTrackActivity,
    getSmartDjContext: () => ({
      tracks,
      activity: trackActivity,
      favoriteTrackIds,
      featureVectors,
    }),
    activeTrackId,
    setActiveTrackId,
    queue,
    setQueue,
    playHistory,
    setPlayHistory,
    podcast: podcastTransport,
  });
  // Late-bound: podcast domain calls arm/seek/toggle without a circular hook import.
  playbackControlsRef.current = {
    seek,
    togglePlay,
    armPodcastPlay,
    clearPlaybackIntent,
    setPlaybackIntent,
    clearPendingPodcastStart,
    peekPendingResumePosition,
    hasEpisodeStartedOnDevice,
  };
  audioEngineRef.current = useAudioEngine({
    podcastAudio: { rate: podcast.podcastPlaybackRate, normalize: podcast.podcastPreferences.normalizeVoice, trim: podcast.podcastPreferences.trimSilence },
    onEnhancementError: () => showActionNotice("语音增强暂不可用，继续原声播放"),
    visualizerVisible: !compactMode.active,
    audioRef,
    volume,
    progress,
    isPlaying,
    activePlayback,
    activePlaybackSourceKey,
    activeTrackId,
  });
  nowPlayingTargetsRef.current = { activePodcastEpisode, activeTrack };
  const {
    playlists,
    setPlaylists,
    homePins,
    setHomePins,
    favoriteTrackIds,
    addToPlaylist,
    removeFromPlaylist,
    reorderPlaylist,
    createPlaylistWithTracks,
  toggleFavorite,
  toggleFavoriteTrack,
  toggleHomePin,
  togglePodcastPin,
    openCreatePlaylistDialog,
    openCreateSmartPlaylist,
    openSmartPlaylistEditor,
    saveSmartPlaylist,
    refreshSmartPlaylist,
    excludeFromSmartPlaylist,
    openPlaylistDialog,
    submitPlaylistDialog,
    saveQueueAsPlaylist,
  } = usePlaylists({
    showActionNotice,
    tracks,
    restored,
    navigateCollection,
    playbackQueueIds,
    activePodcastEpisode,
    activeTrack,
    setSelectedPlaylistId,
    playlistDialog,
    setPlaylistDialog,
    smartPlaylistDialog,
    setSmartPlaylistDialog,
  });

  // quickplay 的播客节目固定项：feed 列表包含未关注的预览节目，固定项在
  // 取消关注后依然可解析；播客库修订（播放/标记/下载）会刷新未读数。
  const [podcastPinFeeds, setPodcastPinFeeds] = useState<PodcastFeed[]>([]);
  const podcastPinFeedsLoadedRef = useRef(false);
  const podcastPinFeedsMountedRef = useMountedRef();
  const libraryPersistenceReadyRef = useRef(false);
  const [podcastFeedRequest, setPodcastFeedRequest] = useState<PodcastFeedRequest | null>(null);
  const loadPodcastPinFeeds = useCallback(() => {
    invoke<PodcastFeed[]>("podcast_list_feeds", { includeUnsubscribed: true })
      .then((feeds) => {
        if (!podcastPinFeedsMountedRef.current) return;
        podcastPinFeedsLoadedRef.current = true;
        setPodcastPinFeeds(feeds);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    loadPodcastPinFeeds();
  }, [podcastLibraryRevision, loadPodcastPinFeeds]);

  // 固定项对账只发生在列表成功加载之后：加载失败时不动用户的固定。
  useEffect(() => {
    if (!podcastPinFeedsLoadedRef.current) return;
    const feedIds = new Set(podcastPinFeeds.map((feed) => feed.id));
    setHomePins((current) => {
      const next = current.filter(
        (pin) => pin.kind !== "podcastFeed" || feedIds.has(pin.targetId),
      );
      return next.length === current.length ? current : next;
    });
  }, [podcastPinFeeds, setHomePins]);

  const pinnedPodcastFeedIds = useMemo(
    () => new Set(
      homePins
        .filter((pin) => pin.kind === "podcastFeed")
        .map((pin) => pin.targetId),
    ),
    [homePins],
  );

  // Pinned podcast tiles stay live while quickplay is visible: entering the
  // page reloads the local snapshot (picks up podcast-page changes), then a
  // throttled conditional RSS refresh pulls new episodes; a slow poll keeps
  // tiles fresh during long sessions on the home page.
  useEffect(() => {
    if (page !== "quickplay" || pinnedPodcastFeedIds.size === 0) return undefined;
    let disposed = false;
    // Always reload locally — cheap, and catches feed refreshes that happened
    // in the podcast view even when the network refresh below is throttled.
    loadPodcastPinFeeds();
    const refreshFeeds = () => {
      const now = Date.now();
      if (now - lastPodcastTileRefreshAt < PODCAST_TILE_REFRESH_MIN_GAP_MS) return;
      lastPodcastTileRefreshAt = now;
      invoke<PodcastRefreshReport>("podcast_refresh_feeds", { force: false })
        .then((report) => {
          if (disposed) return;
          if (report.inserted + report.updated > 0) loadPodcastPinFeeds();
        })
        .catch(() => undefined);
    };
    refreshFeeds();
    const timer = window.setInterval(refreshFeeds, PODCAST_TILE_REFRESH_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [page, pinnedPodcastFeedIds, loadPodcastPinFeeds]);

  function openPodcastFeedFromPin(feedId: string) {
    const feed = podcastPinFeeds.find((candidate) => candidate.id === feedId);
    setPodcastFeedRequest({ feedId, feed, nonce: Date.now() });
    requestNavigation("podcasts");
  }

  useEffect(() => () => {
    if (actionNoticeTimerRef.current) window.clearTimeout(actionNoticeTimerRef.current);
    void flushPodcastProgress();
  }, []);

  useEffect(() => {
    if (!restored || !isPlaying || activePodcastEpisode || !activeTrack) return;
    void metadata.enrichArtistForPlayback(activeTrack);
  }, [
    activePodcastEpisode,
    activeTrack,
    isPlaying,
    metadata.enrichArtistForPlayback,
    restored,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function restoreLibrary() {
      try {
        let snapshot = await musicGetLibrarySnapshot();
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!snapshot.hasLibrary && saved) {
          snapshot = await migrateLegacyState(localStorage, STORAGE_KEY, (legacy) =>
            musicImportLegacyPlayerState(legacy as Parameters<typeof musicImportLegacyPlayerState>[0]),
          ) ?? snapshot;
        }

        if (cancelled) return;
        libraryPersistenceReadyRef.current = true;

        setFolders(snapshot.folders ?? []);
        setTracks(snapshot.tracks ?? []);
        restoreMusicPosition(snapshot.playback.activeTrackId ?? null, snapshot.playback.positionSeconds ?? 0);
        setActiveTrackId(snapshot.playback.activeTrackId ?? null);
        setQueue(snapshot.playback.queue ?? []);
        setPlayHistory(snapshot.playback.playHistory ?? []);
        setTrackActivity(snapshot.trackActivity ?? {});
        setVolume(snapshot.playback.volume ?? 0.8);
        setShuffle(snapshot.playback.shuffle ?? false);
        setRepeat(snapshot.playback.repeat ?? "off");
        setPlaylists(normalizePlaylists(snapshot.playlists));
        setSelectedPlaylistId(snapshot.playback.selectedPlaylistId ?? DEFAULT_PLAYLIST_ID);
        setHomePins(normalizeHomePins(snapshot.homePins));
        setNeedsMetadataRefresh(false);
      } catch (error) {
        if (cancelled) return;
        showActionNotice("音乐资料库恢复失败，旧数据已保留，请重启重试");
        if (import.meta.env.DEV) console.warn("[library] restore failed", error);
        // Fallback to legacy localStorage if DB path is unavailable.
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          try {
            const state = JSON.parse(saved);
            setFolders(state.folders ?? []);
            setTracks(state.tracks ?? []);
            setActiveTrackId(state.activeTrackId ?? null);
            setQueue(state.queue ?? []);
            setPlayHistory(state.playHistory ?? []);
            activityMigrationRef.current = !state.trackActivity || (
              state.librarySchemaVersion !== LIBRARY_SCHEMA_VERSION
              && Object.keys(state.trackActivity ?? {}).length === 0
              && (state.tracks?.length ?? 0) > 0
            );
            setTrackActivity(state.trackActivity ?? {});
            setVolume(state.volume ?? 0.8);
            setShuffle(state.shuffle ?? false);
            setRepeat(state.repeat ?? "off");
            setPlaylists(normalizePlaylists(state.playlists));
            setSelectedPlaylistId(state.selectedPlaylistId ?? DEFAULT_PLAYLIST_ID);
            setHomePins(normalizeHomePins(state.homePins));
            setNeedsMetadataRefresh(state.librarySchemaVersion !== LIBRARY_SCHEMA_VERSION);
          } catch {
            // Retain even malformed data so recovery never destroys the source.
          }
        }
      } finally {
        if (!cancelled) setRestored(true);
      }
    }

    void restoreLibrary();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!restored || !libraryPersistenceReadyRef.current) return;
    const savePlayback = () => {
      if (clearingLibraryRef.current) return;
      void trackMusicWrite(musicSavePlaybackState({
        activeTrackId,
        positionSeconds: getMusicPosition(),
        queue,
        playHistory,
        volume,
        shuffle,
        repeat,
        selectedPlaylistId,
      })).catch((error) => {
        setPersistenceFailed(true);
        recordDiagnostic({ domain: "library", event: "save_playback_state", outcome: "error" });
        if (import.meta.env.DEV) console.warn("[library] save playback state failed", error);
      });
    };
    const timer = window.setTimeout(savePlayback, 250);
    const checkpoint = isPlaying && !activePodcastEpisode ? window.setInterval(savePlayback, 5000) : null;
    return () => { window.clearTimeout(timer); if (checkpoint !== null) window.clearInterval(checkpoint); };
  }, [restored, clearingLibrary, activeTrackId, queue, playHistory, volume, shuffle, repeat, selectedPlaylistId, isPlaying, activePodcastEpisode?.episodeId, isPlaying || activePodcastEpisode ? null : progress]);

  useEffect(() => {
    if (!restored || tracks.length === 0) return;
    let cancelled = false;
    async function hydrateFeatures() {
      try {
        await musicAnalyzeFeatures(80);
        const vectors = await musicListTrackFeatures();
        if (!cancelled) setFeatureVectors(vectors ?? {});
      } catch (error) {
        if (import.meta.env.DEV) console.warn("[features] hydrate failed", error);
      }
    }
    void hydrateFeatures();
    return () => {
      cancelled = true;
    };
  }, [restored, tracks.length]);

  useEffect(() => {
    if (!restored || tracks.length === 0) return;
    let cancelled = false;
    async function resumeSmartDjIfNeeded() {
      try {
        const record = await musicGetRadioSession();
        if (cancelled || !record || record.status !== "playing") return;
        restoreSmartDjSession(record);
      } catch (error) {
        if (import.meta.env.DEV) console.warn("[smartdj] resume failed", error);
      }
    }
    void resumeSmartDjIfNeeded();
    return () => {
      cancelled = true;
    };
  }, [restored, tracks.length]);

  useEffect(() => {
    if (!restored || !libraryPersistenceReadyRef.current) return;
    const timer = window.setTimeout(() => {
      if (clearingLibraryRef.current) return;
      void trackMusicWrite(musicSaveTrackActivity(trackActivity)).catch((error) => {
        setPersistenceFailed(true);
        recordDiagnostic({ domain: "library", event: "save_track_activity", outcome: "error" });
        if (import.meta.env.DEV) console.warn("[library] save track activity failed", error);
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [restored, clearingLibrary, trackActivity]);

  useEffect(() => {
    if (!restored || !libraryPersistenceReadyRef.current) return;
    const timer = window.setTimeout(() => {
      if (clearingLibraryRef.current) return;
      void trackMusicWrite(musicSavePlaylists(playlists)).catch((error) => {
        setPersistenceFailed(true);
        recordDiagnostic({ domain: "library", event: "save_playlists", outcome: "error" });
        if (import.meta.env.DEV) console.warn("[library] save playlists failed", error);
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [restored, clearingLibrary, playlists]);

  useEffect(() => {
    if (!restored || !libraryPersistenceReadyRef.current) return;
    const timer = window.setTimeout(() => {
      if (clearingLibraryRef.current) return;
      void trackMusicWrite(musicSaveHomePins(homePins)).catch((error) => {
        setPersistenceFailed(true);
        recordDiagnostic({ domain: "library", event: "save_home_pins", outcome: "error" });
        if (import.meta.env.DEV) console.warn("[library] save home pins failed", error);
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [restored, clearingLibrary, homePins]);

  const [podcastArtworkCoverPath, setPodcastArtworkCoverPath] = useState<string | null>(null);

  useEffect(() => {
    const artworkUrl = activePodcastEpisode?.artworkUrl ?? null;
    if (!artworkUrl) {
      setPodcastArtworkCoverPath(null);
      return;
    }
    let cancelled = false;
    void invoke<string | null>("podcast_cache_artwork", { url: artworkUrl })
      .then((coverPath) => {
        if (!cancelled) setPodcastArtworkCoverPath(coverPath ?? null);
      })
      .catch((error) => {
        if (!cancelled) setPodcastArtworkCoverPath(null);
        if (import.meta.env.DEV) console.warn("[podcast] cache artwork failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, [activePodcastEpisode?.artworkUrl]);

  const systemMediaItem = useMemo(() => {
    if (!podcastSessionHydrated) return null;
    if (activePodcastEpisode) {
      return {
        id: `podcast:${activePodcastEpisode.episodeId}`,
        title: activePodcastEpisode.title,
        artist: activePodcastEpisode.podcastTitle,
        album: "播客",
        coverPath: podcastArtworkCoverPath,
      };
    }
    if (!activeTrack) return null;
    return {
      id: activeTrack.id,
      title: activeTrack.title,
      artist: activeTrack.artist,
      album: activeTrack.album,
      coverPath: activeTrack.cover_path ?? null,
    };
  }, [activePodcastEpisode, activeTrack, podcastArtworkCoverPath, podcastSessionHydrated]);

  const isActiveTrackFavorite = activeTrack ? favoriteTrackIds.has(activeTrack.id) : false;

  function showContextMenu(event: React.MouseEvent, payload: ContextPayload) {
    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button,a[href],[tabindex]') : null;
    const fallback = event.currentTarget instanceof HTMLElement ? event.currentTarget.querySelector<HTMLElement>('button,a[href]') : null;
    (target || fallback)?.focus({ preventScroll: true });
    setContextMenu({ x: event.clientX, y: event.clientY, payload });
  }

  function playContextPayload(payload: ContextPayload) {
    const track = payload.kind === "track" ? payload.tracks[0] : null;
    if (track) {
      playTrack(track, payload.playbackTracks ?? payload.tracks);
      return;
    }
    playTracks(payload.tracks);
  }

  function startSmartDjFromPayload(payload: ContextPayload) {
    if (payload.tracks.length === 0) {
      showActionNotice("没有可用于 SmartDJ 的歌曲");
      return;
    }
    const seedTrack = payload.tracks[0];
    const seedId = payload.kind === "track"
      ? seedTrack.id
      : payload.kind === "playlist"
        ? (payload.playlistId ?? seedTrack.id)
        : payload.title;
    const seed = seedFromTracks(
      payload.kind === "album" || payload.kind === "artist" || payload.kind === "playlist"
        ? payload.kind
        : "track",
      seedId,
      payload.title,
      payload.tracks,
    );
    startSmartDj(seed);
    // Acoustic features are produced by the background Rust worker for the
    // whole library; SmartDJ picks them up via the hydrate effect below.
  }

  function openPayloadInCollection(payload: ContextPayload) {
    const entity = referenceForPayload(collectionIndex, payload);
    if (entity) openCollectionEntity(entity);
    else showActionNotice("此内容已不在曲库中");
  }

  function openTrackRelation(track: Track, kind: "artist" | "album") {
    if (kind === "artist") {
      const artist = collectionIndex.artistsByName.get(track.artist);
      if (artist) openCollectionEntity(artistReference(artist));
    } else {
      const album = collectionIndex.albumByTrackId.get(track.id);
      if (album) openCollectionEntity(albumReference(album));
    }
  }

  function openMetadata(payload: ContextPayload) {
    // The metadata editor targets performer tags, not album-artist credits.
    const artist = payload.kind === "artist" ? collectionIndex.artistsByName.get(payload.targetId || payload.title) : undefined;
    setInfoTarget(artist ? { ...payload, tracks: artist.performedTracks } : payload);
  }

  function closeContextMenu() {
    setContextMenu(null);
  }


  useEffect(() => {
    let unlisteners: Array<() => void> = [];
    let cancelled = false;
    async function bindTrayEvents() {
      try {
        const pairs: Array<[string, () => void]> = [
          ["zone://tray-toggle", () => togglePlay()],
          ["zone://tray-previous", () => {
            if (activePodcastEpisode) seek(Math.max(0, progress - 15));
            else move(-1);
          }],
          ["zone://tray-next", () => {
            if (activePodcastEpisode) playNextPodcastEpisode();
            else move(1);
          }],
        ];
        for (const [eventName, handler] of pairs) {
          const unlisten = await listen(eventName, handler);
          if (cancelled) {
            unlisten();
            return;
          }
          unlisteners.push(unlisten);
        }
      } catch (error) {
        if (import.meta.env.DEV) console.warn("[tray] listen failed", error);
      }
    }
    void bindTrayEvents();
    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [activePodcastEpisode, progress, togglePlay, move, seek, playNextPodcastEpisode]);


  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    // Only intercept OS/titlebar close while "close to tray" is enabled.
    // Leaving a no-op listener registered after the setting flips off can still
    // race with window.close() and make the close button feel dead.
    if (!closeToTray) {
      return () => {
        cancelled = true;
      };
    }
    void appWindow
      .onCloseRequested(async (event) => {
        // Must prevent immediately; async work happens after.
        event.preventDefault();
        try {
          await appWindow.hide();
        } catch (error) {
          if (import.meta.env.DEV) console.warn("[window] hide on close failed", error);
          try {
            await appWindow.destroy();
          } catch {
            await appWindow.close();
          }
        }
      })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [closeToTray]);

  useAppHotkeys({
    onTogglePlay: togglePlay,
    onPrevious: () => {
      if (activePodcastEpisode) seek(Math.max(0, progress - podcast.podcastPreferences.backwardSeconds));
      else move(-1);
    },
    onNext: () => {
      if (activePodcastEpisode) playNextPodcastEpisode();
      else move(1);
    },
    onVolumeUp: () => setVolume((value) => Math.min(1, Number((value + 0.05).toFixed(2)))),
    onVolumeDown: () => setVolume((value) => Math.max(0, Number((value - 0.05).toFixed(2)))),
    onSeekLeft: () => seek(Math.max(0, progress - 5)),
    onSeekRight: () => {
      const total = duration > 0 ? duration : progress + 5;
      seek(Math.min(total, progress + 5));
    },
    onDislikeSmartDj: () => {
      if (!activePodcastEpisode) dislikeSmartDjTrack();
    },
  });

  useSystemMedia({
    media: systemMediaItem,
    isPlaying,
    canPrevious: activePodcastEpisode ? true : canMovePrevious,
    canNext: activePodcastEpisode
      ? podcastQueue.some((item) => item.episode.id !== activePodcastEpisode.episodeId)
      : canMoveNext,
    duration,
    position: progress,
    isFavorite: activePodcastEpisode ? Boolean(activePodcastEpisode.saved) : isActiveTrackFavorite,
    onPlay: () => {
      if (audioRef.current?.paused) togglePlay();
    },
    onPause: () => {
      pausePlayback();
    },
    onToggle: togglePlay,
    onPrevious: () => {
      if (activePodcastEpisode) seek(Math.max(0, progress - podcast.podcastPreferences.backwardSeconds));
      else move(-1);
    },
    onNext: () => {
      if (activePodcastEpisode) playNextPodcastEpisode();
      else move(1);
    },
    onSeek: seek,
    onFavorite: () => {
      if (activePodcastEpisode) void toggleActivePodcastSaved();
      else toggleFavorite();
    },
  });

  // Overlays and chrome build their element ahead of the Presence wrapper so
  // `useLastNonNull` can freeze the closing snapshot for the exit window.
  // Chrome fades out together with the outgoing page when a navigation targets
  // now playing — not after the page flip, which read as a lingering flash.
  const chromeVisible = !compactMode.active && page !== "nowPlaying";
  const appHeaderElement = chromeVisible ? (
    <AppHeader
      page={page}
      onNavigate={navigatePage}
    />
  ) : null;
  const playerBarElement = chromeVisible && podcastSessionHydrated ? (
    activePodcastEpisode ? (
      <PodcastPlayerBar
        rateScope={podcast.podcastPlaybackRateScope}
        onRecordMoment={() => void podcast.recordPodcastMoment()}
        playbackRate={podcastPlaybackRate} sleepTimer={podcastSleepTimer} queueCount={podcastQueue.filter(item=>item.episode.id!==activePodcastEpisode.episodeId).length}
        onPlaybackRate={setPodcastPlaybackRate} onSleepTimer={setPodcastSleepTimer}
        onOpenQueue={()=>{setPodcastQueueRequest(++podcastQueueRequestNonce.current);navigatePage("podcasts");}}
        episode={activePodcastEpisode}
        isPlaying={isPlaying}
        progress={progress}
        duration={duration}
        volume={volume}
        status={podcastPlaybackStatus}
        backwardSeconds={podcast.podcastPreferences.backwardSeconds}
        forwardSeconds={podcast.podcastPreferences.forwardSeconds}
        onPlayPause={togglePlay}
        onRetry={retryPodcastPlayback}
        onSeek={seek}
        onVolume={setVolume}
        onOpenPodcasts={() => navigatePage("podcasts")}
        onOpenNowPlaying={openNowPlaying}
      />
    ) : (
      <PlayerBar
        track={activeTrack}
        isPlaying={isPlaying}
        progress={progress}
        duration={duration}
        volume={volume}
        shuffle={shuffle}
        repeat={repeat}
        isFavorite={isActiveTrackFavorite}
        onPlayPause={togglePlay}
        onPrevious={() => move(-1)}
        onNext={() => move(1)}
        onSeek={seek}
        onVolume={setVolume}
        onShuffle={() => setShuffle((value) => !value)}
        onRepeat={() => setRepeat((value) => (value === "off" ? "all" : value === "all" ? "one" : "off"))}
        onToggleFavorite={toggleFavorite}
        onOpenNowPlaying={openNowPlaying}
        onNavigateCollection={navigateCollection}
      />
    )
  ) : null;
  const contextTrack = contextMenu?.payload.kind === "track" ? collectionIndex.trackById.get(contextMenu.payload.tracks[0]?.id) : undefined;
  const currentCollectionEntity: CollectionEntityRef | null = page === "collection" && !(collection.location.query.trim() && collection.location.searchMode === "results")
    ? collection.location.entity ?? (view === "playlists" ? { kind: "playlist", id: selectedPlaylistId } : null) : null;
  const contextEntity = contextMenu ? referenceForPayload(collectionIndex, contextMenu.payload) : null;
  const contextArtist = contextTrack && collectionIndex.artistsByName.get(contextTrack.artist);
  const contextAlbum = contextTrack && collectionIndex.albumByTrackId.get(contextTrack.id);
  const canVisit = (target: CollectionEntityRef | null) => target && !sameCollectionEntity(collectionIndex, target, currentCollectionEntity);
  const contextPlaylist = contextMenu?.payload.playlistId ? playlists.find(playlist => playlist.id === contextMenu.payload.playlistId) : undefined;
  const editableTrackIds = contextTrack && contextPlaylist && !isSmartPlaylist(contextPlaylist) && contextPlaylist.id !== DEFAULT_PLAYLIST_ID ? contextPlaylist.trackIds : null;
  const editableTrackIndex = contextTrack && editableTrackIds ? editableTrackIds.indexOf(contextTrack.id) : -1;
  const contextMenuElement = contextMenu ? (
    <ContextMenu
      key={`${contextMenu.x}:${contextMenu.y}:${contextMenu.payload.kind}:${contextMenu.payload.title}`}
      menu={contextMenu}
      onClose={closeContextMenu}
      onPlay={() => playContextPayload(contextMenu.payload)}
      onPlayNext={() => playNext(contextMenu.payload.tracks)}
      onAddToQueue={() => appendToQueue(contextMenu.payload.tracks)}
      onStartSmartDj={() => startSmartDjFromPayload(contextMenu.payload)}
      onDislikeSmartDj={() => dislikeSmartDjTrack()}
      onAddToPlaylist={() => setAddToPlaylistTarget(contextMenu.payload)}
      onAddToFavorites={() => addToPlaylist(DEFAULT_PLAYLIST_ID, contextMenu.payload.tracks)}
      onRenamePlaylist={(playlistId) => openPlaylistDialog("rename", playlistId)}
      onDeletePlaylist={(playlistId) => openPlaylistDialog("delete", playlistId)}
      onExcludeFromSmartPlaylist={(playlistId) => excludeFromSmartPlaylist(playlistId, contextMenu.payload.tracks)}
      homePinState={homePinStateForPayload(homePins, contextMenu.payload)}
      onToggleHomePin={() => toggleHomePin(contextMenu.payload)}
      onOpenInCollection={canVisit(contextEntity) ? () => openPayloadInCollection(contextMenu.payload) : undefined}
      onOpenArtist={contextTrack && contextArtist && canVisit(artistReference(contextArtist)) ? () => openTrackRelation(contextTrack, "artist") : undefined}
      onOpenAlbum={contextTrack && contextAlbum && canVisit(albumReference(contextAlbum)) ? () => openTrackRelation(contextTrack, "album") : undefined}
      onRemoveFromPlaylist={editableTrackIds && contextTrack && contextPlaylist ? () => removeFromPlaylist(contextPlaylist.id, [contextTrack]) : undefined}
      onMoveInPlaylist={editableTrackIds && editableTrackIndex >= 0 && contextTrack && contextPlaylist ? {
        up: editableTrackIndex > 0 ? () => reorderPlaylist(contextPlaylist.id, contextTrack.id, editableTrackIds[editableTrackIndex - 1]) : undefined,
        down: editableTrackIndex < editableTrackIds.length - 1 ? () => reorderPlaylist(contextPlaylist.id, contextTrack.id, editableTrackIds[editableTrackIndex + 1]) : undefined,
      } : undefined}
      onInfo={() => openMetadata(contextMenu.payload)}
    />
  ) : null;
  const infoPanelElement = infoTarget ? (
    <InfoPanel payload={infoTarget} metadata={metadata} onClose={() => setInfoTarget(null)} />
  ) : null;
  const addToPlaylistDialogElement = addToPlaylistTarget ? (
    <AddToPlaylistDialog
      payload={addToPlaylistTarget}
      playlists={playlists}
      onCancel={() => setAddToPlaylistTarget(null)}
      onChoose={(playlistId) => {
        addToPlaylist(playlistId, addToPlaylistTarget.tracks);
        setAddToPlaylistTarget(null);
      }}
      onCreate={(name) => {
        createPlaylistWithTracks(name, addToPlaylistTarget.tracks);
        setAddToPlaylistTarget(null);
      }}
    />
  ) : null;
  const playlistDialogElement = playlistDialog ? (
    <PlaylistDialog
      key={`${playlistDialog.mode}-${playlistDialog.playlistId ?? "new"}`}
      dialog={playlistDialog}
      onCancel={() => setPlaylistDialog(null)}
      onSubmit={submitPlaylistDialog}
      onCreateSmart={openCreateSmartPlaylist}
    />
  ) : null;
  const smartPlaylistDialogElement = smartPlaylistDialog ? (
    <SmartPlaylistDialog
      key={smartPlaylistDialog === "create" ? "create-smart" : smartPlaylistDialog.id}
      playlist={smartPlaylistDialog === "create" ? undefined : smartPlaylistDialog}
      tracks={tracks}
      favoriteTrackIds={favoriteTrackIds}
      activity={trackActivity}
      onCancel={() => setSmartPlaylistDialog(null)}
      onSave={saveSmartPlaylist}
    />
  ) : null;
  async function retryLibraryPersistence() {
    if (retryingPersistence || clearingLibraryRef.current) return;
    setRetryingPersistence(true);
    const results = await Promise.allSettled([
      trackMusicWrite(musicSavePlaylists(playlists)), trackMusicWrite(musicSaveHomePins(homePins)), trackMusicWrite(musicSaveTrackActivity(trackActivity)),
      trackMusicWrite(musicSavePlaybackState({ activeTrackId, positionSeconds: getMusicPosition(), queue, playHistory, volume, shuffle, repeat, selectedPlaylistId })),
    ]);
    const failed = results.some(result => result.status === "rejected");
    setPersistenceFailed(failed);
    setRetryingPersistence(false);
    recordDiagnostic({ domain: "library", event: "save_retry", outcome: failed ? "error" : "ok" });
    if (!failed) showActionNotice("资料库状态已保存");
  }

  const actionToastElement = persistenceFailed ? (
    <div className="action-toast" role="alert">部分资料库状态未保存
      <Button variant="ghost" busy={retryingPersistence} onClick={() => void retryLibraryPersistence()}>重试</Button>
    </div>
  ) : compactMode.error ? (
    <div className="action-toast" role="alert">{compactMode.error}</div>
  ) : actionNotice ? (
    <div className="action-toast" role="status">{actionNotice}</div>
  ) : null;
  const lastAppHeaderElement = useLastNonNull(appHeaderElement);
  const lastPlayerBarElement = useLastNonNull(playerBarElement);
  const lastContextMenuElement = useLastNonNull(contextMenuElement);
  const lastInfoPanelElement = useLastNonNull(infoPanelElement);
  const lastAddToPlaylistDialogElement = useLastNonNull(addToPlaylistDialogElement);
  const lastPlaylistDialogElement = useLastNonNull(playlistDialogElement);
  const lastSmartPlaylistDialogElement = useLastNonNull(smartPlaylistDialogElement);
  const lastActionToastElement = useLastNonNull(actionToastElement);

  async function changeCompactMode(value: boolean) {
    if (document.querySelector('[aria-modal="true"]')) return false;
    closeContextMenu();
    if (!await compactMode.setCompact(value)) return false;
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".titlebar-mode")?.focus({ preventScroll: true }));
    return true;
  }

  return (
    <div
      className={`shell ${compactMode.active ? "shell-compact" : page === "nowPlaying" ? "shell-now-playing" : ""}`}
      data-page-motion="managed"
      style={
        {
          "--motion-dir": navDir,
          "--motion-drift": `${navDrift}px`,
        } as CSSProperties
      }
      onClick={closeContextMenu}
      onContextMenu={(event) => {
        event.preventDefault();
        closeContextMenu();
      }}
    >
      <audio
        ref={audioRef}
        crossOrigin="anonymous"
        onTimeUpdate={(event) => handleTimeUpdate(event.currentTarget.currentTime, event.currentTarget.duration || duration)}
        onLoadedMetadata={(event) => handleLoadedMetadata(event.currentTarget)}
        onLoadStart={handleAudioLoadStart}
        onPlay={() => {
          setIsPlaying(true);
          markPodcastPlaying();
        }}
        onPause={handleAudioPause}
        onWaiting={handleAudioWaiting}
        onStalled={handleAudioWaiting}
        onCanPlay={handleAudioCanPlay}
        onError={handleAudioError}
        onEnded={onEnded}
      />
      <Titlebar
        showSettings={!compactMode.active && page !== "nowPlaying"}
        isSettings={page === "settings"}
        onOpenSettings={animate => navigatePage("settings", animate)}
        closeToTray={closeToTray}
        compact={compactMode.active}
        modePending={compactMode.pending}
        onToggleCompact={() => void changeCompactMode(!compactMode.active)}
        pinned={compactMode.pinned}
        onTogglePinned={() => {
          void compactMode.setPinned(!compactMode.pinned).then(() => {
            window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".titlebar-pin")?.focus({ preventScroll: true }));
          });
        }}
      />

      {!compactMode.active && page !== "nowPlaying" && (
        <AudioGlowCanvas isPlaying={isPlaying && activePlayback?.kind === "music"} volume={volume} />
      )}

      {compactMode.active ? <CompactPlayerView
        index={collectionIndex} playlists={playlists} activity={trackActivity} favoriteTrackIds={favoriteTrackIds}
        track={activeTrack} queueIds={playbackQueueIds} episode={activePodcastEpisode} podcastQueue={podcastQueue}
        podcastStatus={podcastPlaybackStatus} playbackRate={podcastPlaybackRate} isPlaying={isPlaying}
        ready={restored && podcastSessionHydrated} progress={progress} duration={duration} volume={volume} shuffle={shuffle} repeat={repeat}
        onPlay={playTrack} onPlayTracks={playTracks} onToggleFavorite={toggleFavoriteTrack} onPlayPause={togglePlay}
        onPrevious={() => move(-1)} onNext={() => { if (activePodcastEpisode) playNextPodcastEpisode(); else move(1); }}
        onSeek={seek} onVolume={setVolume} onShuffle={() => setShuffle(value => !value)}
        onRepeat={() => setRepeat(value => value === "off" ? "all" : value === "all" ? "one" : "off")}
        onPlaybackRate={setPodcastPlaybackRate} onToggleSaved={() => void toggleActivePodcastSaved()}
        onPlayEpisode={playPodcastQueueEpisodeById} onRetryPodcast={retryPodcastPlayback}
        onOpenNormal={async target => {
          if (await changeCompactMode(false) && target) {
            if (target === "collection") { setSelectedPlaylistId("now"); navigateCollection("playlists"); }
            else requestNavigation(target);
          }
        }}
      /> : <main ref={workspaceRef} className="workspace" data-page={page}>
        <Presence show={appHeaderElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
          {appHeaderElement ?? lastAppHeaderElement ?? <span style={{ display: "none" }} />}
        </Presence>

        {page === "quickplay" ? (
          <QuickplayView
            animateEntrance={quickplayEntrance && navigationAnimated}
            tracks={tracks}
            albums={albums}
            artists={artists}
            playlists={playlists}
            activeTrack={activeTrack}
            historyIds={playHistory}
            activity={trackActivity}
            favoriteTrackIds={favoriteTrackIds}
            homePins={homePins}
            onPlay={playTrack}
            onPlayTracks={playTracks}
            onOpenNowPlaying={openNowPlaying}
            onOpenCollection={navigateCollection}
            onResumePlayback={() => {
              if (audioRef.current?.paused) togglePlay();
            }}
            onMovePin={(sourceId, targetId, placeAfter) => setHomePins((current) => moveHomePin(current, sourceId, targetId, placeAfter))}
            onShiftPin={(pinId, direction) => setHomePins((current) => shiftHomePin(current, pinId, direction))}
            onResizePin={(pinId, size) => setHomePins((current) => setHomePinSize(current, pinId, size))}
            onCustomizePin={(pinId, patch) => setHomePins((current) => customizeHomePin(current, pinId, patch))}
            onTogglePin={toggleHomePin}
            onContextMenu={showContextMenu}
            podcastActive={Boolean(activePodcastEpisode)}
            podcastFeeds={podcastPinFeeds}
            onOpenPodcastFeed={openPodcastFeedFromPin}
            onTogglePodcastPin={(feedId) => {
              const feed = podcastPinFeeds.find((candidate) => candidate.id === feedId);
              if (feed) togglePodcastPin(feed);
            }}
          />
        ) : null}

        {page === "collection" && <CollectionView view={view} index={collectionIndex} navigation={collection}
          onTravel={travelCollection} onOpen={openCollectionEntity} searchInputRef={searchInputRef}
          onQuery={setCollectionSearchQuery} onClearSearch={clearCollectionSearch}
          queueIds={playbackQueueIds} activeTrackId={activeTrackId} onPlay={playTrack} onPlayTracks={playTracks}
          onContextMenu={showContextMenu} playlists={playlists} selectedPlaylistId={selectedPlaylistId}
          onSelectPlaylist={setSelectedPlaylistId} onCreatePlaylist={openCreatePlaylistDialog}
          onEditSmartPlaylist={openSmartPlaylistEditor} onRefreshSmartPlaylist={refreshSmartPlaylist}
          trackActivity={trackActivity} favoriteTrackIds={favoriteTrackIds} onToggleFavorite={toggleFavoriteTrack}
          onAddFolder={addFolder} isScanning={isScanning} scanNote={scanNote}
          onReorderPlaylist={reorderPlaylist}
          onAddToQueue={appendToQueue} onInfo={openMetadata} onAddToPlaylist={setAddToPlaylistTarget} />}

        {page === "podcasts" && (
          <Suspense fallback={loadingPage}>
          <PodcastView
            queueRequest={podcastQueueRequest} onQueueRequestHandled={nonce=>setPodcastQueueRequest(value=>value===nonce?0:value)}
            activeEpisode={activePodcastEpisode}
            activeEpisodeId={activePodcastEpisode?.episodeId ?? null}
            activeProgress={progress}
            activeDuration={duration}
            libraryRevision={podcastLibraryRevision}
            autoQueueMode={podcastAutoQueueMode}
            isPlaying={isPlaying && Boolean(activePodcastEpisode)}
            queue={podcastQueue}
            episodeRequest={podcastEpisodeRequest}
            onEpisodeRequestHandled={(nonce) => {
              resolvePodcastEpisodeRequest(nonce);
            }}
            feedRequest={podcastFeedRequest}
            onFeedRequestHandled={(nonce) => {
              setPodcastFeedRequest((current) =>
                current?.nonce === nonce ? null : current
              );
            }}
            pinnedPodcastFeedIds={pinnedPodcastFeedIds}
            onTogglePodcastPin={togglePodcastPin}
            onPlayEpisode={playPodcastEpisode}
            onPlayPlaylist={playPodcastPlaylist}
            onPlayEpisodeAt={(episode, positionSeconds) =>
              playPodcastEpisode(episode, positionSeconds)}
            onQueueEpisode={queuePodcastEpisode}
            onRemoveQueueEpisode={removePodcastQueueEpisode}
            onRemoveQueueEpisodes={removePodcastQueueEpisodes}
            onMoveQueueEpisode={movePodcastQueueEpisode}
            onReorderQueueEpisode={reorderPodcastQueueEpisode}
            onClearQueue={clearPodcastQueue}
            queueUndoAvailable={podcast.queueUndoAvailable}
            queueUndoKind={podcast.queueUndoKind}
            onUndoQueueRemoval={podcast.undoPodcastQueueRemoval}
            playbackRate={podcastPlaybackRate}
            onEpisodeUpdated={updatePodcastEpisode}
            onSetEpisodePlayed={setPodcastEpisodePlayed}
            onSetQueueEpisodesPlayed={setPodcastQueueEpisodesPlayed}
            onDownloadQueueEpisodes={downloadPodcastQueueEpisodes}
            onAutoQueueMode={changePodcastAutoQueueMode}
            onDownloadsDeleted={reconcileDeletedPodcastDownloads}
            onReturnToNowPlaying={() => requestNavigation("nowPlaying")}
          />
          </Suspense>
        )}

        {page === "nowPlaying" && (
          activePodcastEpisode ? (
            <PodcastNowPlayingView
              rateScope={podcast.podcastPlaybackRateScope}
              onRecordMoment={() => void podcast.recordPodcastMoment()}
              episode={activePodcastEpisode}
              queue={podcastQueue}
              status={podcastPlaybackStatus}
              isPlaying={isPlaying}
              progress={progress}
              duration={duration}
              volume={volume}
              playbackRate={podcastPlaybackRate}
              backwardSeconds={podcast.podcastPreferences.backwardSeconds}
              forwardSeconds={podcast.podcastPreferences.forwardSeconds}
              sleepTimer={podcastSleepTimer}
              onBack={() => requestNavigation(previousPageRef.current)}
              onPlayPause={togglePlay}
              onSeek={seek}
              onVolume={setVolume}
              onPlaybackRate={setPodcastPlaybackRate}
              onSleepTimer={setPodcastSleepTimer}
              onPlayQueueItem={(episodeId) => {
                playPodcastQueueEpisodeById(episodeId);
              }}
              onRemoveQueueItem={removePodcastQueueEpisode}
              onMoveQueueItem={movePodcastQueueEpisode}
              onReorderQueueItem={reorderPodcastQueueEpisode}
              onClearQueue={clearPodcastQueue}
              onOpenEpisode={openActivePodcastEpisode}
              onToggleSaved={toggleActivePodcastSaved}
              onNext={() => playNextPodcastEpisode()}
              onRetry={retryPodcastPlayback}
            />
          ) : (
            <NowPlayingView
              track={activeTrack}
              tracks={tracks}
              queue={playbackQueueIds.map((id) => tracks.find((track) => track.id === id)).filter(Boolean) as Track[]}
              isPlaying={isPlaying}
              playbackClock={() => audioRef.current?.currentTime ?? progress}
              progress={progress}
              duration={duration}
              shuffle={shuffle}
              repeat={repeat}
              isFavorite={isActiveTrackFavorite}
              volume={volume}
              onBack={() => requestNavigation(previousPageRef.current)}
              onPlay={playTrack}
              onPlayPause={togglePlay}
              onToggleFavorite={toggleFavorite}
              onPrevious={() => move(-1)}
              onNext={() => move(1)}
              onSeek={seek}
              onShuffle={() => setShuffle((value) => !value)}
              onRepeat={() => setRepeat((value) => (value === "off" ? "all" : value === "all" ? "one" : "off"))}
              onVolume={setVolume}
              onSaveQueueAsPlaylist={saveQueueAsPlaylist}
              onOpenArtist={activeTrack ? () => openTrackRelation(activeTrack, "artist") : undefined}
              onOpenAlbum={activeTrack ? () => openTrackRelation(activeTrack, "album") : undefined}
            />
          )
        )}

        {page === "settings" && (
          <Suspense fallback={loadingPage}>
          <SettingsView
            folders={folders}
            trackCount={tracks.length}
            isScanning={isScanning}
            metadataProviders={metadata.providers}
            onToggleMetadataProvider={metadata.setProviderEnabled}
            queueInsertMode={queueInsertMode}
            adaptivePrevious={adaptivePrevious}
            onQueueInsertModeChange={(mode) => updatePlaybackBehavior({ queueInsertMode: mode })}
            onAdaptivePreviousChange={(enabled) => updatePlaybackBehavior({ adaptivePrevious: enabled })}
            closeToTray={closeToTray}
            onCloseToTrayChange={(enabled) => updatePlaybackBehavior({ closeToTray: enabled })}
            onAddFolder={addFolder}
            onRescan={() => rescan()}
            onCancelScan={cancelScan}
            scanNote={scanNote}
            onClear={async () => {
              if (clearingLibraryRef.current || isScanning) throw new Error("请等待扫描结束后再清空");
              clearingLibraryRef.current = true;
              setClearingLibrary(true);
              try {
                  await Promise.allSettled([...pendingMusicWritesRef.current]);
                  await musicClearLibrary();
                  setFolders([]);
                  setTracks([]);
                  setQueue([]);
                  setPlayHistory([]);
                  setTrackActivity({});
                  setActiveTrackId(null);
                  setHomePins(current => current.filter(pin => pin.kind === "podcastFeed"));
                  setPlaylists(normalizePlaylists(undefined));
                  setSelectedPlaylistId(DEFAULT_PLAYLIST_ID);
                  setScanNote("");
                  localStorage.removeItem(STORAGE_KEY);
                  setPersistenceFailed(false);
                  showActionNotice("音乐资料库已清空");
              } finally {
                clearingLibraryRef.current = false;
                setClearingLibrary(false);
              }
            }}
          />
          </Suspense>
        )}
      </main>}

      {!compactMode.active && <Presence show={playerBarElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
        {playerBarElement ?? lastPlayerBarElement ?? <span style={{ display: "none" }} />}
      </Presence>}

      <Presence show={contextMenuElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
        {contextMenuElement ?? lastContextMenuElement ?? <span style={{ display: "none" }} />}
      </Presence>

      <Presence show={infoPanelElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
        {infoPanelElement ?? lastInfoPanelElement ?? <span style={{ display: "none" }} />}
      </Presence>

      <Presence show={addToPlaylistDialogElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
        {addToPlaylistDialogElement ?? lastAddToPlaylistDialogElement ?? <span style={{ display: "none" }} />}
      </Presence>

      <Presence show={playlistDialogElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
        {playlistDialogElement ?? lastPlaylistDialogElement ?? <span style={{ display: "none" }} />}
      </Presence>

      <Presence show={smartPlaylistDialogElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
        {smartPlaylistDialogElement ?? lastSmartPlaylistDialogElement ?? <span style={{ display: "none" }} />}
      </Presence>

      <Presence show={actionToastElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
        {actionToastElement ?? lastActionToastElement ?? <span style={{ display: "none" }} />}
      </Presence>
    </div>
  );
}
