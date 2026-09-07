import { recordDiagnostic } from "./utils/diagnostics";
import { Button } from "./components/Button";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Titlebar } from "./components/Titlebar";
import { AppHeader } from "./components/AppHeader";
import { CollectionSearchField } from "./components/CollectionSearchField";
import { EmptyState } from "./components/EmptyState";
import { PlayerBar } from "./components/PlayerBar";
import { PodcastPlayerBar } from "./components/PodcastPlayerBar";
import { ContextMenu } from "./components/ContextMenu";
import { InfoPanel } from "./components/InfoPanel";
import { AddToPlaylistDialog } from "./components/AddToPlaylistDialog";
import { PlaylistDialog, type PlaylistDialogState } from "./components/PlaylistDialog";
import { SmartPlaylistDialog } from "./components/SmartPlaylistDialog";
import { CollectionArtworkBackdrop } from "./components/CollectionArtworkBackdrop";
import { LibraryView } from "./views/LibraryView";
import { SearchResultsView } from "./views/SearchResultsView";
import { QuickplayView } from "./views/QuickplayView";
import { NowPlayingView } from "./views/NowPlayingView";
import { PodcastNowPlayingView } from "./views/PodcastNowPlayingView";
import { SettingsView } from "./views/SettingsView";
import { PodcastView } from "./views/PodcastView";
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
import { formatCollectionPlaylistCount, normalizePlaylists } from "./utils/music";
import { seedFromTracks } from "./utils/smartDj";
import { customizeHomePin, homePinStateForPayload, moveHomePin, normalizeHomePins, setHomePinSize, shiftHomePin } from "./utils/homePins";
import { resolveSearchSurface } from "./utils/collectionSearch";
import { useSystemMedia } from "./hooks/useSystemMedia";
import { useAppHotkeys } from "./hooks/useAppHotkeys";
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
  ViewMode,
} from "./types";
import type { PodcastFeedRequest } from "./views/podcast/types";

// Pinned podcast tiles must stay live without opening the podcast page:
// entering quickplay reloads the local snapshot, and a conditional RSS
// refresh (cheap 304s) pulls new episodes — throttled on re-entry, plus a
// slow poll while the home page stays open.
const PODCAST_TILE_REFRESH_MIN_GAP_MS = 2 * 60_000;
const PODCAST_TILE_REFRESH_INTERVAL_MS = 10 * 60_000;
let lastPodcastTileRefreshAt = 0;

export default function App() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackSessionRef = useRef<PlaybackSession | null>(null);
  const playbackControlsRef = useRef<PlaybackControlsHandle | null>(null);
  const audioEngineRef = useRef<AudioEngineHandle | null>(null);
  const nowPlayingTargetsRef = useRef<NowPlayingTargets>({
    activePodcastEpisode: null,
    activeTrack: null,
  });
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [playHistory, setPlayHistory] = useState<string[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState(DEFAULT_PLAYLIST_ID);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [infoTarget, setInfoTarget] = useState<ContextPayload | null>(null);
  const [addToPlaylistTarget, setAddToPlaylistTarget] = useState<ContextPayload | null>(null);
  const [playlistDialog, setPlaylistDialog] = useState<PlaylistDialogState | null>(null);
  const [smartPlaylistDialog, setSmartPlaylistDialog] = useState<SmartPlaylist | "create" | null>(null);
  const [persistenceFailed, setPersistenceFailed] = useState(false);
  const [retryingPersistence, setRetryingPersistence] = useState(false);
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

  const {
    query,
    searchMode,
    setSearchMode,
    searchInputRef,
    view,
    setView,
    page,
    navExit,
    navDir,
    navDrift,
    navTargetRef,
    navExitTimerRef,
    previousPageRef,
    selectedAlbumKey,
    setSelectedAlbumKey,
    selectedArtistName,
    setSelectedArtistName,
    requestNavigation,
    clearCollectionSearch,
    setCollectionSearchQuery,
    navigatePage,
    navigateCollection,
    openSearchArtist,
    openSearchAlbum,
    openSearchPlaylist,
    openNowPlaying,
  } = useNavigation({
    contextMenu,
    infoTarget,
    addToPlaylistTarget,
    playlistDialog,
    smartPlaylistDialog,
    nowPlayingTargetsRef,
    setSelectedPlaylistId,
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
    albums,
    artists,
    addFolder,
    rescan,
  } = useMusicLibrary({
    view,
    selectedAlbumKey,
    setSelectedAlbumKey,
    setQueue,
  });
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
    visualizerVisible: page === "nowPlaying",
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
    createPlaylistWithTracks,
  toggleFavorite,
  toggleFavoriteTrack,
  toggleHomePin,
  togglePodcastPin,
  openPayloadInCollection,
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
    setSelectedAlbumKey,
    setSelectedArtistName,
    setView,
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
    if (navExitTimerRef.current !== null) window.clearTimeout(navExitTimerRef.current);
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
    const timer = window.setTimeout(() => {
      void musicSavePlaybackState({
        activeTrackId,
        queue,
        playHistory,
        volume,
        shuffle,
        repeat,
        selectedPlaylistId,
      }).catch((error) => {
        setPersistenceFailed(true);
        recordDiagnostic({ domain: "library", event: "save_playback_state", outcome: "error" });
        if (import.meta.env.DEV) console.warn("[library] save playback state failed", error);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [restored, activeTrackId, queue, playHistory, volume, shuffle, repeat, selectedPlaylistId]);

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
      void musicSaveTrackActivity(trackActivity).catch((error) => {
        setPersistenceFailed(true);
        recordDiagnostic({ domain: "library", event: "save_track_activity", outcome: "error" });
        if (import.meta.env.DEV) console.warn("[library] save track activity failed", error);
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [restored, trackActivity]);

  useEffect(() => {
    if (!restored || !libraryPersistenceReadyRef.current) return;
    const timer = window.setTimeout(() => {
      void musicSavePlaylists(playlists).catch((error) => {
        setPersistenceFailed(true);
        recordDiagnostic({ domain: "library", event: "save_playlists", outcome: "error" });
        if (import.meta.env.DEV) console.warn("[library] save playlists failed", error);
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [restored, playlists]);

  useEffect(() => {
    if (!restored || !libraryPersistenceReadyRef.current) return;
    const timer = window.setTimeout(() => {
      void musicSaveHomePins(homePins).catch((error) => {
        setPersistenceFailed(true);
        recordDiagnostic({ domain: "library", event: "save_home_pins", outcome: "error" });
        if (import.meta.env.DEV) console.warn("[library] save home pins failed", error);
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [restored, homePins]);

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
      if (activePodcastEpisode) seek(Math.max(0, progress - 15));
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
      if (audioRef.current && !audioRef.current.paused) togglePlay();
    },
    onToggle: togglePlay,
    onPrevious: () => {
      if (activePodcastEpisode) seek(Math.max(0, progress - 15));
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
  const chromeVisible = page !== "nowPlaying" && !(navExit !== null && navTargetRef.current === "nowPlaying");
  const appHeaderElement = chromeVisible ? (
    <AppHeader
      page={page}
      onNavigate={navigatePage}
    />
  ) : null;
  const playerBarElement = chromeVisible && podcastSessionHydrated ? (
    activePodcastEpisode ? (
      <PodcastPlayerBar
        episode={activePodcastEpisode}
        isPlaying={isPlaying}
        progress={progress}
        duration={duration}
        volume={volume}
        status={podcastPlaybackStatus}
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
  const contextMenuElement = contextMenu ? (
    <ContextMenu
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
      onOpenInCollection={() => openPayloadInCollection(contextMenu.payload)}
      onInfo={() => setInfoTarget(contextMenu.payload)}
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
    if (retryingPersistence) return;
    setRetryingPersistence(true);
    const results = await Promise.allSettled([
      musicSavePlaylists(playlists), musicSaveHomePins(homePins), musicSaveTrackActivity(trackActivity),
      musicSavePlaybackState({ activeTrackId, queue, playHistory, volume, shuffle, repeat, selectedPlaylistId }),
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
  ) : actionNotice ? (
    <div className="action-toast" role="status">{actionNotice}</div>
  ) : null;
  const showSearchResults = resolveSearchSurface(query, searchMode) === "results";
  const lastAppHeaderElement = useLastNonNull(appHeaderElement);
  const lastPlayerBarElement = useLastNonNull(playerBarElement);
  const lastContextMenuElement = useLastNonNull(contextMenuElement);
  const lastInfoPanelElement = useLastNonNull(infoPanelElement);
  const lastAddToPlaylistDialogElement = useLastNonNull(addToPlaylistDialogElement);
  const lastPlaylistDialogElement = useLastNonNull(playlistDialogElement);
  const lastSmartPlaylistDialogElement = useLastNonNull(smartPlaylistDialogElement);
  const lastActionToastElement = useLastNonNull(actionToastElement);

  return (
    <div
      className={`shell ${page === "nowPlaying" ? "shell-now-playing" : ""}`}
      data-nav-state={navExit !== null ? "exiting" : undefined}
      style={
        {
          "--motion-dir": navDir,
          "--motion-drift": `${navDrift.enter}px`,
          "--motion-exit-drift": `${navDrift.exit}px`,
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
        showSettings={page !== "nowPlaying"}
        isSettings={page === "settings"}
        onOpenSettings={() => navigatePage("settings")}
        closeToTray={closeToTray}
      />

      <main className="workspace">
        <Presence show={appHeaderElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
          {appHeaderElement ?? lastAppHeaderElement ?? <span style={{ display: "none" }} />}
        </Presence>

        {page === "quickplay" ? (
          <QuickplayView
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

        {page === "collection" && (
          <section
            className={`content-band collection-band${showSearchResults ? " collection-searching" : ""}`}
          >
            <CollectionArtworkBackdrop
              tracks={tracks}
              activeTrack={activePodcastEpisode ? null : activeTrack}
              surfaceKey={showSearchResults ? "search" : view}
              parallaxEnabled={!showSearchResults}
            />
            <p className="collection-ghost" aria-hidden="true">
              collection
            </p>
            <div className="collection-header">
              <div className="collection-chrome">
                <span className="collection-chrome-label">音乐</span>
                <CollectionSearchField
                  ref={searchInputRef}
                  query={query}
                  onQuery={setCollectionSearchQuery}
                  onClear={clearCollectionSearch}
                  showReturnToResults={query.trim().length > 0 && searchMode === "browse"}
                  onReturnToResults={() => setSearchMode("results")}
                />
              </div>
              <div className="collection-header-main">
                <div className="collection-title">
                  <p>
                    {tracks.length === 0
                      ? "选择一个文件夹开始"
                      : showSearchResults
                        ? "搜索收藏"
                        : view === "albums"
                          ? `${albums.length} 张专辑`
                          : view === "artists"
                            ? `${artists.length} 位艺术家`
                            : view === "playlists"
                              ? formatCollectionPlaylistCount(playlists.length)
                              : `${tracks.length} 首歌曲`}
                    {scanNote ? ` · ${scanNote}` : ""}
                  </p>
                </div>
                {!showSearchResults ? (
                  <nav className="collection-navigation" aria-label="收藏视图">
                    <div className="segmented">
                      {(["artists", "albums", "songs", "playlists"] as ViewMode[]).map((item) => (
                        <button
                          key={item}
                          className={view === item ? "selected" : ""}
                          onClick={() => setView(item)}
                        >
                          {{ artists: "艺术家", albums: "专辑", songs: "歌曲", playlists: "播放列表" }[item]}
                        </button>
                      ))}
                    </div>
                  </nav>
                ) : null}
              </div>
            </div>

            {showSearchResults ? (
              <SearchResultsView
                query={query}
                tracks={tracks}
                albums={albums}
                artists={artists}
                playlists={playlists}
                activity={trackActivity}
                favoriteTrackIds={favoriteTrackIds}
                activeTrackId={activeTrackId}
                onPlay={playTrack}
                onOpenArtist={openSearchArtist}
                onOpenAlbum={openSearchAlbum}
                onOpenPlaylist={openSearchPlaylist}
                onContextMenu={showContextMenu}
              />
            ) : tracks.length === 0 ? (
              <EmptyState onAddFolder={addFolder} isScanning={isScanning} />
            ) : (
              <LibraryView
                key={view}
                view={view}
                tracks={tracks}
                libraryTracks={tracks}
                albums={albums}
                artists={artists}
                queueIds={playbackQueueIds}
                activeTrackId={activeTrackId}
                selectedAlbumKey={selectedAlbumKey}
                onSelectAlbum={setSelectedAlbumKey}
                selectedArtistName={selectedArtistName}
                onPlay={playTrack}
                onPlayTracks={playTracks}
                onContextMenu={showContextMenu}
                playlists={playlists}
                selectedPlaylistId={selectedPlaylistId}
                onSelectPlaylist={setSelectedPlaylistId}
                onCreatePlaylist={openCreatePlaylistDialog}
                onEditSmartPlaylist={openSmartPlaylistEditor}
                onRefreshSmartPlaylist={refreshSmartPlaylist}
                trackActivity={trackActivity}
                favoriteTrackIds={favoriteTrackIds}
                onToggleFavorite={toggleFavoriteTrack}
              />
            )}
          </section>
        )}

        {page === "podcasts" && (
          <PodcastView
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
            onPlayEpisodeAt={(episode, positionSeconds) =>
              playPodcastEpisode(episode, positionSeconds)}
            onQueueEpisode={queuePodcastEpisode}
            onRemoveQueueEpisode={removePodcastQueueEpisode}
            onRemoveQueueEpisodes={removePodcastQueueEpisodes}
            onMoveQueueEpisode={movePodcastQueueEpisode}
            onReorderQueueEpisode={reorderPodcastQueueEpisode}
            onClearQueue={clearPodcastQueue}
            onEpisodeUpdated={updatePodcastEpisode}
            onSetEpisodePlayed={setPodcastEpisodePlayed}
            onSetQueueEpisodesPlayed={setPodcastQueueEpisodesPlayed}
            onDownloadQueueEpisodes={downloadPodcastQueueEpisodes}
            onAutoQueueMode={changePodcastAutoQueueMode}
            onDownloadsDeleted={reconcileDeletedPodcastDownloads}
            onReturnToNowPlaying={() => requestNavigation("nowPlaying")}
          />
        )}

        {page === "nowPlaying" && (
          activePodcastEpisode ? (
            <PodcastNowPlayingView
              episode={activePodcastEpisode}
              queue={podcastQueue}
              status={podcastPlaybackStatus}
              isPlaying={isPlaying}
              progress={progress}
              duration={duration}
              volume={volume}
              playbackRate={podcastPlaybackRate}
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
            />
          )
        )}

        {page === "settings" && (
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
            onClear={() => {
              void musicClearLibrary()
                .catch((error) => {
                  if (import.meta.env.DEV) console.warn("[library] clear failed", error);
                })
                .finally(() => {
                  setFolders([]);
                  setTracks([]);
                  setQueue([]);
                  setPlayHistory([]);
                  setTrackActivity({});
                  setActiveTrackId(null);
                  setHomePins([]);
                  setPlaylists(normalizePlaylists(undefined));
                  setSelectedPlaylistId(DEFAULT_PLAYLIST_ID);
                  setScanNote("");
                  localStorage.removeItem(STORAGE_KEY);
                });
            }}
          />
        )}
      </main>

      <Presence show={playerBarElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
        {playerBarElement ?? lastPlayerBarElement ?? <span style={{ display: "none" }} />}
      </Presence>

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
