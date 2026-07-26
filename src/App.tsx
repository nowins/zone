import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Titlebar } from "./components/Titlebar";
import { AppHeader } from "./components/AppHeader";
import { CollectionSearchField } from "./components/CollectionSearchField";
import { EmptyState } from "./components/EmptyState";
import { PlayerBar } from "./components/PlayerBar";
import { PodcastPlayerBar } from "./components/PodcastPlayerBar";
import { ContextMenu } from "./components/ContextMenu";
import { InfoPanel } from "./components/InfoPanel";
import { PlaylistDialog, type PlaylistDialogState } from "./components/PlaylistDialog";
import { SmartPlaylistDialog, type SmartPlaylistDraft } from "./components/SmartPlaylistDialog";
import { LibraryView } from "./views/LibraryView";
import { SearchResultsView } from "./views/SearchResultsView";
import { QuickplayView } from "./views/QuickplayView";
import { NowPlayingView } from "./views/NowPlayingView";
import { PodcastNowPlayingView } from "./views/PodcastNowPlayingView";
import { SettingsView } from "./views/SettingsView";
import { PodcastView } from "./views/PodcastView";
import { DEFAULT_PLAYLIST_ID, LIBRARY_SCHEMA_VERSION, MAX_HOME_PINS, STORAGE_KEY, VISUALIZER_SAMPLE_COUNT } from "./constants";
import {
  albumKey,
  bestAlbumArtist,
  compareTracksForAlbum,
  defaultPlaylists,
  formatCollectionPlaylistCount,
  normalizePlaylists,
  uniqueIds,
} from "./utils/music";
import { homePinForPayload, homePinStateForPayload, moveHomePin, normalizeHomePins, reconcileHomePins, shiftHomePin } from "./utils/homePins";
import { analyzePcmBeatGrid, createIdleBeatFrame, RealtimeBeatAnalyzer, type BeatFrame, type BeatGrid } from "./utils/beatAnalysis";
import { createAudioVisualizerFrame, createIdleVisualizerFrame } from "./utils/visualizer";
import { getVisualizerFrame, publishVisualizerFrame } from "./utils/visualizerBus";
import { createShuffleOrder, haveSameQueueItems, playbackSourceKey, reconcileActiveTrack, reconcileQueueWithLibrary, resolveQueueMove, type QueueMoveResult } from "./utils/playback";
import { createTrackActivity, isSmartPlaylist } from "./utils/smartPlaylist";
import { movePodcastQueueItem, podcastPlaybackForEpisode } from "./utils/podcastPlayback";
import {
  resolveSearchSurface,
  type CollectionSearchMode,
} from "./utils/collectionSearch";
import { useSystemMedia } from "./hooks/useSystemMedia";
import { useLibraryWatcher } from "./hooks/useLibraryWatcher";
import { Presence, useLastNonNull } from "./motion/presence";
import { MOTION_DURATIONS, MOTION_DRIFT, resolveExitDurationMs } from "./motion/tokens";
import { resolvePageTransition } from "./motion/pageTransition";
import { useReducedMotion } from "./motion/useReducedMotion";
import type {
  AlbumGroup,
  AppPage,
  ArtistGroup,
  ContextMenuState,
  ContextPayload,
  HomePin,
  MusicFolder,
  Playlist,
  PodcastEpisode,
  PodcastEpisodeDetail,
  PodcastPlayback,
  PodcastPlaybackStatus,
  PodcastQueueItem,
  PodcastSleepTimer,
  RepeatMode,
  ScanResult,
  SmartPlaylist,
  Track,
  TrackActivityMap,
  ViewMode,
} from "./types";

type PlaybackSession = {
  trackId: string;
  maxProgress: number;
  countedPlay: boolean;
  countedComplete: boolean;
};

const PODCAST_PROGRESS_SAVE_INTERVAL_MS = 5_000;
const PODCAST_PLAYBACK_SETTINGS_KEY = "zone-podcast-playback-v1";
const PODCAST_PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

function readPodcastPlaybackRate(): number {
  try {
    const stored = JSON.parse(localStorage.getItem(PODCAST_PLAYBACK_SETTINGS_KEY) ?? "{}");
    return PODCAST_PLAYBACK_RATES.includes(stored.playbackRate)
      ? stored.playbackRate
      : 1;
  } catch {
    return 1;
  }
}

function readPodcastActiveEpisodeId(): string | null {
  try {
    const stored = JSON.parse(localStorage.getItem(PODCAST_PLAYBACK_SETTINGS_KEY) ?? "{}");
    return typeof stored.activeEpisodeId === "string" && stored.activeEpisodeId.trim()
      ? stored.activeEpisodeId
      : null;
  } catch {
    return null;
  }
}

export default function App() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previousPageRef = useRef<"quickplay" | "collection" | "podcasts" | "settings">("quickplay");
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const outputGainRef = useRef<GainNode | null>(null);
  const visualizerFrameRef = useRef<number | null>(null);
  const visualizerSilenceFramesRef = useRef(0);
  const visualizerUnavailableRef = useRef(false);
  const visualizerEnergyRef = useRef(0.055);
  const visualizerSamplesRef = useRef<number[]>([]);
  const beatFrameRef = useRef<BeatFrame>(createIdleBeatFrame());
  const realtimeBeatRef = useRef<RealtimeBeatAnalyzer | null>(null);
  const offlineBeatGridRef = useRef<BeatGrid | null>(null);
  const beatGridCacheRef = useRef(new Map<string, BeatGrid | null>());
  const beatAnalysisRequestRef = useRef(0);
  const actionNoticeTimerRef = useRef<number | null>(null);
  const navExitTimerRef = useRef<number | null>(null);
  const navTargetRef = useRef<AppPage | null>(null);
  const playbackSessionRef = useRef<PlaybackSession | null>(null);
  const activeAudioSourceKeyRef = useRef<string | null>(null);
  const audioPlayAttemptRef = useRef(0);
  const activePodcastEpisodeRef = useRef<PodcastPlayback | null>(null);
  const podcastAudioEpisodeRef = useRef<string | null>(null);
  const podcastQueueRef = useRef<PodcastQueueItem[]>([]);
  const podcastQueueRevisionRef = useRef(0);
  const podcastQueueMutationRef = useRef<Promise<void>>(Promise.resolve());
  const pendingPodcastQueueConsumeRef = useRef<string | null>(null);
  const podcastPlaybackStartedEpisodeRef = useRef<string | null>(null);
  const pendingPodcastResumeRef = useRef<{ episodeId: string; position: number } | null>(null);
  const podcastProgressSaveRef = useRef<{
    episodeId: string;
    savedAt: number;
    position: number;
    duration: number;
  } | null>(null);
  const podcastProgressMutationRef = useRef<Promise<void>>(Promise.resolve());
  const podcastPlaybackIntentRef = useRef(false);
  const podcastSessionHydratedRef = useRef(false);
  const podcastSessionRestoreCancelledRef = useRef(false);
  const podcastSleepTimerRef = useRef<number | null>(null);
  const activityMigrationRef = useRef(false);
  const scanInFlightRef = useRef(false);
  const queuedScanRef = useRef<{ folders: MusicFolder[]; automatic: boolean } | null>(null);
  const [folders, setFolders] = useState<MusicFolder[]>([]);
  const foldersRef = useRef<MusicFolder[]>(folders);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<CollectionSearchMode>("results");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const focusSearchPendingRef = useRef(false);
  const [view, setView] = useState<ViewMode>("albums");
  const [page, setPage] = useState<AppPage>("quickplay");
  // Page-transition state: `navExit` is the in-flight exit direction (null when
  // idle), `navDir` persists the latest direction so the incoming page's enter
  // keyframe reads the same `--motion-dir` after the exit window ends. `navDrift`
  // carries the table's per-pair amplitudes onto the shell (`--motion-drift` for
  // the enter keyframe, `--motion-exit-drift` for the exit one), so push/pop
  // travel further than a peer pivot instead of sharing one hardcoded distance.
  const [navExit, setNavExit] = useState<1 | -1 | null>(null);
  const [navDir, setNavDir] = useState<1 | -1>(1);
  const [navDrift, setNavDrift] = useState<{ enter: number; exit: number }>({
    enter: MOTION_DRIFT.m,
    exit: MOTION_DRIFT.s,
  });
  const reducedMotion = useReducedMotion();
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const [activePodcastEpisode, setActivePodcastEpisode] = useState<PodcastPlayback | null>(null);
  const [podcastQueue, setPodcastQueue] = useState<PodcastQueueItem[]>([]);
  const [podcastLibraryRevision, setPodcastLibraryRevision] = useState(0);
  const [podcastEpisodeRequest, setPodcastEpisodeRequest] = useState<{
    episodeId: string;
    nonce: number;
    returnToNowPlaying?: boolean;
  } | null>(null);
  const [podcastPlaybackRate, setPodcastPlaybackRate] = useState(readPodcastPlaybackRate);
  const [podcastSleepTimer, setPodcastSleepTimer] = useState<PodcastSleepTimer>(null);
  const [podcastPlaybackStatus, setPodcastPlaybackStatus] = useState<PodcastPlaybackStatus>("idle");
  const [podcastSessionHydrated, setPodcastSessionHydrated] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  const [playHistory, setPlayHistory] = useState<string[]>([]);
  const [trackActivity, setTrackActivity] = useState<TrackActivityMap>({});
  const [isPlaying, setIsPlaying] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanNote, setScanNote] = useState("");
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [shuffle, setShuffle] = useState(false);
  const [shuffleOrder, setShuffleOrder] = useState<string[]>([]);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [restored, setRestored] = useState(false);
  const [needsMetadataRefresh, setNeedsMetadataRefresh] = useState(false);
  const [selectedAlbumKey, setSelectedAlbumKey] = useState<string | null>(null);
  const [selectedArtistName, setSelectedArtistName] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>(defaultPlaylists());
  const [selectedPlaylistId, setSelectedPlaylistId] = useState(DEFAULT_PLAYLIST_ID);
  const [homePins, setHomePins] = useState<HomePin[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [infoTarget, setInfoTarget] = useState<ContextPayload | null>(null);
  const [playlistDialog, setPlaylistDialog] = useState<PlaylistDialogState | null>(null);
  const [smartPlaylistDialog, setSmartPlaylistDialog] = useState<SmartPlaylist | "create" | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  foldersRef.current = folders;
  activePodcastEpisodeRef.current = activePodcastEpisode;
  podcastQueueRef.current = podcastQueue;

  useLibraryWatcher(folders, restored, () => {
    void rescan(folders, true);
  });

  useEffect(() => () => {
    if (actionNoticeTimerRef.current) window.clearTimeout(actionNoticeTimerRef.current);
    if (navExitTimerRef.current !== null) window.clearTimeout(navExitTimerRef.current);
    if (podcastSleepTimerRef.current !== null) window.clearTimeout(podcastSleepTimerRef.current);
    void flushPodcastProgress();
  }, []);

  useEffect(() => {
    if (page !== "collection" || !focusSearchPendingRef.current) return;
    focusSearchPendingRef.current = false;
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [page]);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      setRestored(true);
      return;
    }

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
      localStorage.removeItem(STORAGE_KEY);
    } finally {
      setRestored(true);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    const revision = podcastQueueRevisionRef.current;
    void invoke<PodcastQueueItem[]>("podcast_list_queue")
      .then((items) => {
        if (!disposed && podcastQueueRevisionRef.current === revision) {
          applyPodcastQueue(items);
        }
      })
      .catch((reason) => {
        if (import.meta.env.DEV) console.warn("[podcast] queue restore failed", reason);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const episodeId = readPodcastActiveEpisodeId();
    if (!episodeId) {
      podcastSessionHydratedRef.current = true;
      setPodcastSessionHydrated(true);
      return;
    }
    void invoke<PodcastEpisodeDetail>("podcast_get_episode_detail", { episodeId })
      .then((detail) => {
        if (disposed) return;
        podcastSessionHydratedRef.current = true;
        if (podcastSessionRestoreCancelledRef.current || activePodcastEpisodeRef.current) {
          setPodcastSessionHydrated(true);
          localStorage.setItem(
            PODCAST_PLAYBACK_SETTINGS_KEY,
            JSON.stringify({
              playbackRate: readPodcastPlaybackRate(),
              activeEpisodeId: activePodcastEpisodeRef.current?.episodeId ?? null,
            }),
          );
          return;
        }
        podcastPlaybackIntentRef.current = false;
        setActivePodcastEpisode(podcastPlaybackForEpisode(detail.episode));
        setPodcastPlaybackStatus("paused");
        setPodcastSessionHydrated(true);
      })
      .catch((reason) => {
        if (disposed) return;
        podcastSessionHydratedRef.current = true;
        setPodcastSessionHydrated(true);
        if (podcastSessionRestoreCancelledRef.current || activePodcastEpisodeRef.current) {
          localStorage.setItem(
            PODCAST_PLAYBACK_SETTINGS_KEY,
            JSON.stringify({
              playbackRate: readPodcastPlaybackRate(),
              activeEpisodeId: activePodcastEpisodeRef.current?.episodeId ?? null,
            }),
          );
          return;
        }
        localStorage.setItem(
          PODCAST_PLAYBACK_SETTINGS_KEY,
          JSON.stringify({ playbackRate: readPodcastPlaybackRate(), activeEpisodeId: null }),
        );
        if (import.meta.env.DEV) {
          console.warn("[podcast] playback session restore failed", reason);
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!podcastSessionHydratedRef.current) return;
    localStorage.setItem(
      PODCAST_PLAYBACK_SETTINGS_KEY,
      JSON.stringify({
        playbackRate: podcastPlaybackRate,
        activeEpisodeId: activePodcastEpisode?.episodeId ?? null,
      }),
    );
    if (activePodcastEpisode && audioRef.current) {
      audioRef.current.playbackRate = podcastPlaybackRate;
    }
  }, [activePodcastEpisode?.episodeId, podcastPlaybackRate]);

  useEffect(() => {
    const episodeId = activePodcastEpisode?.episodeId;
    if (
      episodeId
      && podcastQueue.some((item) => item.episode.id === episodeId)
      && pendingPodcastQueueConsumeRef.current === null
    ) {
      pendingPodcastQueueConsumeRef.current = episodeId;
      if (podcastPlaybackStartedEpisodeRef.current === episodeId) {
        consumePendingPodcastQueueEpisode(episodeId);
      }
    }
  }, [activePodcastEpisode?.episodeId, podcastQueue]);

  useEffect(() => {
    if (!podcastSleepTimer) return;
    if (
      !activePodcastEpisode
      || (
        podcastSleepTimer.kind === "episodeEnd"
        && podcastSleepTimer.episodeId !== activePodcastEpisode.episodeId
      )
    ) {
      setPodcastSleepTimer(null);
    }
  }, [activePodcastEpisode, podcastSleepTimer]);

  useEffect(() => {
    if (podcastSleepTimerRef.current !== null) {
      window.clearTimeout(podcastSleepTimerRef.current);
      podcastSleepTimerRef.current = null;
    }
    if (!activePodcastEpisode || podcastSleepTimer?.kind !== "deadline") return;
    const remaining = Math.max(0, podcastSleepTimer.deadlineAt - Date.now());
    podcastSleepTimerRef.current = window.setTimeout(() => {
      podcastSleepTimerRef.current = null;
      flushPodcastProgress();
      podcastPlaybackIntentRef.current = false;
      audioPlayAttemptRef.current += 1;
      audioRef.current?.pause();
      setPodcastSleepTimer(null);
      setPodcastPlaybackStatus("paused");
      showActionNotice("睡眠定时已暂停播放");
    }, remaining);
    return () => {
      if (podcastSleepTimerRef.current !== null) {
        window.clearTimeout(podcastSleepTimerRef.current);
        podcastSleepTimerRef.current = null;
      }
    };
  }, [activePodcastEpisode?.episodeId, podcastSleepTimer]);

  useEffect(() => {
    if (!restored || folders.length === 0 || tracks.length === 0) return;
    if (!needsMetadataRefresh && "cover_path" in tracks[0]) return;

    void rescan(folders);
  }, [restored, needsMetadataRefresh]);

  useEffect(() => {
    if (!restored) return;

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        librarySchemaVersion: needsMetadataRefresh ? LIBRARY_SCHEMA_VERSION - 1 : LIBRARY_SCHEMA_VERSION,
        folders,
        tracks,
        activeTrackId,
        queue,
        playHistory,
        trackActivity,
        volume,
        shuffle,
        repeat,
        playlists,
        selectedPlaylistId,
        homePins,
      }),
    );
  }, [restored, needsMetadataRefresh, folders, tracks, activeTrackId, queue, playHistory, trackActivity, volume, shuffle, repeat, playlists, selectedPlaylistId, homePins]);

  useEffect(() => {
    if (!activeTrackId) return;
    setPlayHistory((current) => [activeTrackId, ...current.filter((id) => id !== activeTrackId)].slice(0, 24));
  }, [activeTrackId]);

  useEffect(() => {
    if (!restored) return;
    if (activityMigrationRef.current && needsMetadataRefresh) return;
    const now = Date.now();
    const isMigrating = activityMigrationRef.current;
    setTrackActivity((current) => {
      const next: TrackActivityMap = {};
      for (const track of tracks) {
        const migrationBaseline = isMigrating ? track.added_at ?? now : now;
        next[track.id] = createTrackActivity(current[track.id], migrationBaseline);
      }
      return next;
    });
    activityMigrationRef.current = false;
  }, [needsMetadataRefresh, restored, tracks]);

  useEffect(() => {
    playbackSessionRef.current = !activePodcastEpisode && activeTrackId
      ? { trackId: activeTrackId, maxProgress: 0, countedPlay: false, countedComplete: false }
      : null;
  }, [activePodcastEpisode?.episodeId, activeTrackId]);

  const activeTrack = useMemo(
    () => tracks.find((track) => track.id === activeTrackId) ?? null,
    [tracks, activeTrackId],
  );
  const activePlayback = useMemo(() => {
    if (!podcastSessionHydrated) return null;
    if (activePodcastEpisode) return { kind: "podcast" as const, episode: activePodcastEpisode };
    if (activeTrack) return { kind: "music" as const, track: activeTrack };
    return null;
  }, [activePodcastEpisode, activeTrack, podcastSessionHydrated]);
  const systemMediaItem = useMemo(() => {
    if (!podcastSessionHydrated) return null;
    if (activePodcastEpisode) {
      return {
        id: `podcast:${activePodcastEpisode.episodeId}`,
        title: activePodcastEpisode.title,
        artist: activePodcastEpisode.podcastTitle,
        album: "播客",
        coverPath: null,
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
  }, [activePodcastEpisode, activeTrack, podcastSessionHydrated]);
  const activePlaybackSourceKey = activePlayback?.kind === "podcast"
    ? `podcast\0${activePlayback.episode.episodeId}\0${activePlayback.episode.playbackLocalPath ?? "stream"}`
    : activePlayback
      ? `music\0${playbackSourceKey(activePlayback.track)}`
      : null;

  const baseQueueIds = useMemo(
    () => (queue.length > 0 ? queue : tracks.map((track) => track.id)),
    [queue, tracks],
  );

  const playbackQueueIds = useMemo(
    () => shuffle && haveSameQueueItems(shuffleOrder, baseQueueIds) ? shuffleOrder : baseQueueIds,
    [baseQueueIds, shuffle, shuffleOrder],
  );

  const activePlaybackIndex = playbackQueueIds.indexOf(activeTrackId ?? "");
  const canMovePrevious = !activePodcastEpisode && Boolean(activeTrack) && (
    repeat === "all" ? playbackQueueIds.length > 1 : activePlaybackIndex > 0
  );
  const canMoveNext = !activePodcastEpisode && Boolean(activeTrack) && (
    repeat === "all"
      ? playbackQueueIds.length > 1
      : activePlaybackIndex >= 0 && activePlaybackIndex < playbackQueueIds.length - 1
  );

  useEffect(() => {
    if (!restored) return;
    const libraryIds = tracks.map((track) => track.id);

    setQueue((current) => reconcileQueueWithLibrary(current, libraryIds));
    setPlayHistory((current) => {
      const validIds = new Set(libraryIds);
      const next = current.filter((id) => validIds.has(id));
      return next.length === current.length ? current : next;
    });
    setActiveTrackId((current) => reconcileActiveTrack(current, queue, libraryIds));
  }, [restored, tracks]);

  useEffect(() => {
    if (!restored) return;
    setHomePins((current) => {
      const next = reconcileHomePins(current, tracks, playlists);
      return next.length === current.length && next.every((pin, index) => pin.id === current[index]?.id)
        ? current
        : next;
    });
  }, [playlists, restored, tracks]);

  useEffect(() => {
    if (!shuffle) {
      setShuffleOrder([]);
      return;
    }

    setShuffleOrder(createShuffleOrder(baseQueueIds, activeTrackId));
  }, [baseQueueIds, shuffle]);

  const favoriteTrackIds = useMemo<Set<string>>(() => {
    const favorites = playlists.find((playlist) => playlist.id === DEFAULT_PLAYLIST_ID);
    return new Set(favorites && !isSmartPlaylist(favorites) ? favorites.trackIds : []);
  }, [playlists]);

  const isActiveTrackFavorite = activeTrack ? favoriteTrackIds.has(activeTrack.id) : false;

  const albums = useMemo(() => {
    const map = new Map<string, Track[]>();
    for (const track of tracks) {
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
  }, [tracks]);

  useEffect(() => {
    if (view !== "albums") return;
    if (albums.length === 0) {
      setSelectedAlbumKey(null);
      return;
    }

    if (!selectedAlbumKey || !albums.some((album) => album.key === selectedAlbumKey)) {
      setSelectedAlbumKey(albums[0].key);
    }
  }, [albums, selectedAlbumKey, view]);

  const artists = useMemo<ArtistGroup[]>(() => {
    const map = new Map<string, Track[]>();
    for (const track of tracks) map.set(track.artist, [...(map.get(track.artist) ?? []), track]);
    return Array.from(map.entries())
      .map(([artist, artistTracks]) => ({ artist, tracks: artistTracks }))
      .sort((a, b) => a.artist.localeCompare(b.artist));
  }, [tracks]);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (!isPlaying || activePlayback?.kind !== "music") {
      if (visualizerFrameRef.current) {
        cancelAnimationFrame(visualizerFrameRef.current);
        visualizerFrameRef.current = null;
      }
      beatFrameRef.current = createIdleBeatFrame();
      if (activePlayback?.kind === "podcast") publishPodcastVisualizerReset();
      else publishIdleBeatFrame();
      return;
    }

    startVisualizer();
    return () => {
      if (visualizerFrameRef.current) {
        cancelAnimationFrame(visualizerFrameRef.current);
        visualizerFrameRef.current = null;
      }
    };
  }, [activePlaybackSourceKey, isPlaying]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const sourceKey = activePlaybackSourceKey;
    const playAttempt = audioPlayAttemptRef.current + 1;
    audioPlayAttemptRef.current = playAttempt;
    activeAudioSourceKeyRef.current = sourceKey;
    if (!activePlayback) {
      podcastAudioEpisodeRef.current = null;
      podcastPlaybackStartedEpisodeRef.current = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      setProgress(0);
      setDuration(0);
      setIsPlaying(false);
      setPodcastPlaybackStatus("idle");
      return;
    }

    const podcastEpisodeId = activePlayback.kind === "podcast"
      ? activePlayback.episode.episodeId
      : null;
    podcastAudioEpisodeRef.current = podcastEpisodeId;
    const sourceUrl = activePlayback.kind === "podcast"
      ? activePlayback.episode.playbackLocalPath
        ? convertFileSrc(activePlayback.episode.playbackLocalPath, "zone-audio")
        : convertFileSrc(activePlayback.episode.episodeId, "zone-podcast")
      : convertFileSrc(activePlayback.track.path, "zone-audio");
    visualizerUnavailableRef.current = false;
    realtimeBeatRef.current = null;
    offlineBeatGridRef.current = activePlayback.kind === "music"
      ? beatGridCacheRef.current.get(activePlayback.track.id) ?? null
      : null;
    beatFrameRef.current = createIdleBeatFrame();
    if (activePlayback.kind === "music") {
      podcastPlaybackStartedEpisodeRef.current = null;
      publishIdleBeatFrame();
      pendingPodcastResumeRef.current = null;
      setPodcastPlaybackStatus("idle");
      void preAnalyzeBeatGrid(activePlayback.track);
    } else {
      if (podcastPlaybackStartedEpisodeRef.current !== podcastEpisodeId) {
        podcastPlaybackStartedEpisodeRef.current = null;
      }
      beatAnalysisRequestRef.current += 1;
      publishPodcastVisualizerReset();
      setPodcastPlaybackStatus("loading");
      pendingPodcastResumeRef.current = {
        episodeId: activePlayback.episode.episodeId,
        position: activePlayback.episode.savedProgressSeconds,
      };
    }
    setProgress(
      activePlayback.kind === "podcast"
        ? Math.max(0, activePlayback.episode.savedProgressSeconds)
        : 0,
    );
    setDuration(
      activePlayback.kind === "podcast"
        ? Math.max(0, activePlayback.episode.durationSeconds ?? 0)
        : 0,
    );
    audio.crossOrigin = "anonymous";
    audio.src = sourceUrl;
    audio.playbackRate = activePlayback.kind === "podcast" ? podcastPlaybackRate : 1;
    audio.load();

    const shouldAutoplay = activePlayback.kind === "music" || podcastPlaybackIntentRef.current;
    if (!shouldAutoplay) {
      setIsPlaying(false);
      if (activePlayback.kind === "podcast") setPodcastPlaybackStatus("paused");
      return;
    }

    void audio
      .play()
      .then(() => {
        if (
          activeAudioSourceKeyRef.current !== sourceKey
          || audioPlayAttemptRef.current !== playAttempt
        ) return;
        setIsPlaying(true);
        if (podcastEpisodeId) {
          podcastPlaybackStartedEpisodeRef.current = podcastEpisodeId;
          setPodcastPlaybackStatus("playing");
          consumePendingPodcastQueueEpisode(podcastEpisodeId);
        }
        void resumeAudioGraph();
      })
      .catch(() => {
        if (
          activeAudioSourceKeyRef.current !== sourceKey
          || audioPlayAttemptRef.current !== playAttempt
        ) return;
        setIsPlaying(false);
        if (activePlayback.kind === "podcast") setPodcastPlaybackStatus("error");
      });
  }, [activePlaybackSourceKey]);

  async function addFolder() {
    const folder = await invoke<MusicFolder | null>("select_music_folder");
    if (!folder || folders.some((item) => item.path === folder.path)) return;

    const nextFolders = [...folders, folder];
    setFolders(nextFolders);
    await rescan(nextFolders);
  }

  async function rescan(targetFolders = folders, automatic = false) {
    if (targetFolders.length === 0) return;
    if (scanInFlightRef.current) {
      queuedScanRef.current = { folders: targetFolders, automatic };
      return;
    }
    scanInFlightRef.current = true;
    setIsScanning(true);
    setScanNote(automatic ? "检测到文件变化，正在同步" : "正在扫描");

    try {
      let pending: { folders: MusicFolder[]; automatic: boolean } | null = {
        folders: targetFolders,
        automatic,
      };
      while (pending) {
        queuedScanRef.current = null;
        setScanNote(pending.automatic ? "检测到文件变化，正在同步" : "正在扫描");
        const result = await invoke<ScanResult>("scan_library", {
          folders: pending.folders.map((folder) => folder.path),
        });
        const requestedFolders = pending.folders.map((folder) => folder.path).join("\u0000");
        const currentFolders = foldersRef.current.map((folder) => folder.path).join("\u0000");
        if (requestedFolders === currentFolders) {
          const scannedIds = result.tracks.map((track) => track.id);
          setTracks(result.tracks);
          setQueue((current) => reconcileQueueWithLibrary(current, scannedIds));
          setScanNote(`已索引 ${result.tracks.length} 首歌曲`);
          setNeedsMetadataRefresh(false);
        }
        pending = queuedScanRef.current;
      }
    } catch (error) {
      setScanNote("曲库同步失败");
      if (import.meta.env.DEV) console.warn("[library] scan failed", error);
    } finally {
      scanInFlightRef.current = false;
      setIsScanning(false);
    }
  }

  function cancelPodcastSessionRestore() {
    if (podcastSessionHydratedRef.current) return;
    podcastSessionRestoreCancelledRef.current = true;
    podcastSessionHydratedRef.current = true;
    setPodcastSessionHydrated(true);
  }

  function playTrack(track: Track, sourceTracks = tracks) {
    cancelPodcastSessionRestore();
    setQueue(sourceTracks.map((item) => item.id));
    if (activePodcastEpisode) {
      flushPodcastProgress();
      podcastPlaybackIntentRef.current = false;
      audioPlayAttemptRef.current += 1;
      audioRef.current?.pause();
      pendingPodcastQueueConsumeRef.current = null;
      setActivePodcastEpisode(null);
      setActiveTrackId(track.id);
      return;
    }
    if (track.id === activeTrackId) {
      recordSkipIfEligible();
      restartCurrentPlayback();
    }
    else {
      recordSkipIfEligible();
      audioPlayAttemptRef.current += 1;
      setActiveTrackId(track.id);
    }
  }

  function playTracks(targetTracks: Track[]) {
    if (targetTracks.length === 0) return;
    cancelPodcastSessionRestore();
    setQueue(targetTracks.map((track) => track.id));
    if (activePodcastEpisode) {
      flushPodcastProgress();
      podcastPlaybackIntentRef.current = false;
      audioPlayAttemptRef.current += 1;
      audioRef.current?.pause();
      pendingPodcastQueueConsumeRef.current = null;
      setActivePodcastEpisode(null);
      setActiveTrackId(targetTracks[0].id);
      return;
    }
    if (targetTracks[0].id === activeTrackId) {
      recordSkipIfEligible();
      restartCurrentPlayback();
    }
    else {
      recordSkipIfEligible();
      audioPlayAttemptRef.current += 1;
      setActiveTrackId(targetTracks[0].id);
    }
  }

  function playPodcastEpisode(episode: PodcastPlayback) {
    cancelPodcastSessionRestore();
    const current = activePodcastEpisode;
    if (
      current?.episodeId === episode.episodeId
      && (current.localPath ?? null) === (episode.localPath ?? null)
    ) {
      togglePlay();
      return;
    }

    flushPodcastProgress();
    podcastPlaybackIntentRef.current = true;
    playbackSessionRef.current = null;
    audioPlayAttemptRef.current += 1;
    audioRef.current?.pause();
    setPodcastPlaybackStatus("loading");
    pendingPodcastQueueConsumeRef.current = podcastQueueRef.current.some(
      (item) => item.episode.id === episode.id,
    )
      ? episode.id
      : null;
    setActivePodcastEpisode(episode);
  }

  function applyPodcastQueue(items: PodcastQueueItem[]) {
    podcastQueueRef.current = items;
    setPodcastQueue(items);
  }

  function beginPodcastQueueMutation(items: PodcastQueueItem[]) {
    const revision = podcastQueueRevisionRef.current + 1;
    podcastQueueRevisionRef.current = revision;
    applyPodcastQueue(items);
    return revision;
  }

  function applyPodcastQueueResult(items: PodcastQueueItem[], revision: number) {
    if (podcastQueueRevisionRef.current === revision) {
      applyPodcastQueue(items);
    }
  }

  function serializePodcastQueueMutation(operation: () => Promise<void>) {
    const next = podcastQueueMutationRef.current.then(operation, operation);
    podcastQueueMutationRef.current = next.catch(() => undefined);
    return next;
  }

  function reloadPodcastQueue(revision: number) {
    return invoke<PodcastQueueItem[]>("podcast_list_queue")
      .then((items) => applyPodcastQueueResult(items, revision))
      .catch(() => undefined);
  }

  function consumePendingPodcastQueueEpisode(episodeId: string) {
    if (
      pendingPodcastQueueConsumeRef.current !== episodeId
      || activePodcastEpisodeRef.current?.episodeId !== episodeId
      || podcastAudioEpisodeRef.current !== episodeId
    ) {
      return;
    }
    pendingPodcastQueueConsumeRef.current = null;
    const revision = beginPodcastQueueMutation(podcastQueueRef.current
      .filter((item) => item.episode.id !== episodeId)
      .map((item, position) => ({ ...item, position }))
    );
    void serializePodcastQueueMutation(async () => {
      try {
        const items = await invoke<PodcastQueueItem[]>("podcast_queue_remove", { episodeId });
        applyPodcastQueueResult(items, revision);
      } catch (reason) {
        await reloadPodcastQueue(revision);
        showActionNotice("无法同步待播队列");
        if (import.meta.env.DEV) console.warn("[podcast] queue consume failed", reason);
      }
    });
  }

  function queuePodcastEpisode(episode: PodcastEpisode, playNext: boolean) {
    if (activePodcastEpisodeRef.current?.episodeId === episode.id) {
      showActionNotice("本集正在播放");
      return;
    }
    const current = podcastQueueRef.current;
    const existing = current.find((item) => item.episode.id === episode.id);
    const remaining = current.filter((item) => item.episode.id !== episode.id);
    const queueItem = existing ?? {
      episode,
      position: remaining.length,
      addedAt: Date.now(),
    };
    const optimistic = (playNext
      ? [queueItem, ...remaining]
      : existing
        ? current
        : [...remaining, queueItem]
    ).map((item, position) => ({ ...item, position }));
    const revision = beginPodcastQueueMutation(optimistic);
    return serializePodcastQueueMutation(async () => {
      try {
        const items = await invoke<PodcastQueueItem[]>("podcast_queue_add", {
          episodeId: episode.id,
          playNext,
        });
        applyPodcastQueueResult(items, revision);
        showActionNotice(playNext ? "将在当前单集之后播放" : "已加入待播队列");
      } catch (reason) {
        await reloadPodcastQueue(revision);
        showActionNotice("无法更新待播队列");
        if (import.meta.env.DEV) console.warn("[podcast] queue add failed", reason);
      }
    });
  }

  function removePodcastQueueEpisode(episodeId: string) {
    const optimistic = podcastQueueRef.current
      .filter((item) => item.episode.id !== episodeId)
      .map((item, position) => ({ ...item, position }));
    const revision = beginPodcastQueueMutation(optimistic);
    return serializePodcastQueueMutation(async () => {
      try {
        const items = await invoke<PodcastQueueItem[]>("podcast_queue_remove", { episodeId });
        applyPodcastQueueResult(items, revision);
      } catch (reason) {
        await reloadPodcastQueue(revision);
        showActionNotice("无法移除待播单集");
        if (import.meta.env.DEV) console.warn("[podcast] queue remove failed", reason);
      }
    });
  }

  function clearPodcastQueue() {
    const revision = beginPodcastQueueMutation([]);
    return serializePodcastQueueMutation(async () => {
      try {
        await invoke("podcast_queue_clear");
        applyPodcastQueueResult([], revision);
        showActionNotice("已清空待播队列");
      } catch (reason) {
        await reloadPodcastQueue(revision);
        showActionNotice("无法清空待播队列");
        if (import.meta.env.DEV) console.warn("[podcast] queue clear failed", reason);
      }
    });
  }

  function movePodcastQueueEpisode(episodeId: string, direction: -1 | 1) {
    const next = movePodcastQueueItem(
      podcastQueueRef.current,
      episodeId,
      direction,
      activePodcastEpisodeRef.current?.episodeId,
    );
    if (next === podcastQueueRef.current) return;
    const revision = beginPodcastQueueMutation(next);
    return serializePodcastQueueMutation(async () => {
      try {
        const items = await invoke<PodcastQueueItem[]>("podcast_queue_reorder", {
          episodeIds: next.map((item) => item.episode.id),
        });
        applyPodcastQueueResult(items, revision);
      } catch (reason) {
        await reloadPodcastQueue(revision);
        showActionNotice("无法调整待播顺序");
        if (import.meta.env.DEV) console.warn("[podcast] queue reorder failed", reason);
      }
    });
  }

  function reorderPodcastQueueEpisode(
    episodeId: string,
    targetEpisodeId: string,
    placement: "before" | "after",
  ) {
    const current = podcastQueueRef.current;
    const sourceIndex = current.findIndex((item) => item.episode.id === episodeId);
    const targetIndex = current.findIndex((item) => item.episode.id === targetEpisodeId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
    const next = [...current];
    const [moved] = next.splice(sourceIndex, 1);
    if (!moved) return;
    const remainingTargetIndex = next.findIndex(
      (item) => item.episode.id === targetEpisodeId,
    );
    const insertionIndex = remainingTargetIndex + (placement === "after" ? 1 : 0);
    next.splice(insertionIndex, 0, moved);
    const reordered = next.map((item, position) => ({ ...item, position }));
    if (reordered.every((item, index) => item.episode.id === current[index]?.episode.id)) {
      return;
    }
    const revision = beginPodcastQueueMutation(reordered);
    return serializePodcastQueueMutation(async () => {
      try {
        const items = await invoke<PodcastQueueItem[]>("podcast_queue_reorder", {
          episodeIds: reordered.map((item) => item.episode.id),
        });
        applyPodcastQueueResult(items, revision);
      } catch (reason) {
        await reloadPodcastQueue(revision);
        showActionNotice("无法调整待播顺序");
        if (import.meta.env.DEV) console.warn("[podcast] queue drag reorder failed", reason);
      }
    });
  }

  function updatePodcastEpisode(episode: PodcastEpisode) {
    applyPodcastQueue(podcastQueueRef.current.map((item) =>
      item.episode.id === episode.id ? { ...item, episode } : item
    ));
    setActivePodcastEpisode((current) => {
      if (!current || current.id !== episode.id) return current;
      const next = podcastPlaybackForEpisode(episode);
      const audio = audioRef.current;
      if (current.playbackLocalPath && !episode.localPath) {
        return {
          ...next,
          savedProgressSeconds: audio?.currentTime ?? current.savedProgressSeconds,
          playbackLocalPath: null,
        };
      }
      return {
        ...next,
        playbackLocalPath: current.playbackLocalPath,
        savedProgressSeconds: current.savedProgressSeconds,
      };
    });
  }

  async function toggleActivePodcastSaved() {
    const episode = activePodcastEpisodeRef.current;
    if (!episode) return;
    try {
      const detail = await invoke<PodcastEpisodeDetail>("podcast_set_episode_saved", {
        episodeId: episode.episodeId,
        saved: !episode.saved,
      });
      updatePodcastEpisode(detail.episode);
      showActionNotice(detail.saved ? "已加入稍后听" : "已从稍后听移除");
    } catch (reason) {
      showActionNotice("无法更新稍后听");
      if (import.meta.env.DEV) console.warn("[podcast] save episode failed", reason);
    }
  }

  function setPodcastEpisodePlayed(episodeId: string, played: boolean) {
    const operation = podcastProgressMutationRef.current.then(() =>
      invoke<PodcastEpisodeDetail>("podcast_set_episode_played", {
        episodeId,
        played,
      })
    );
    podcastProgressMutationRef.current = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  function openActivePodcastEpisode() {
    const episode = activePodcastEpisodeRef.current;
    if (!episode) return;
    setPodcastEpisodeRequest({
      episodeId: episode.episodeId,
      nonce: Date.now(),
      returnToNowPlaying: true,
    });
    requestNavigation("podcasts");
  }

  function playPodcastQueueItem(item: PodcastQueueItem) {
    playPodcastEpisode(podcastPlaybackForEpisode(item.episode));
  }

  function playNextPodcastEpisode(showEmptyNotice = true) {
    const activeEpisodeId = activePodcastEpisodeRef.current?.episodeId ?? null;
    if (
      activeEpisodeId
      && podcastQueueRef.current.some((item) => item.episode.id === activeEpisodeId)
    ) {
      void removePodcastQueueEpisode(activeEpisodeId);
    }
    const next = podcastQueueRef.current.find(
      (item) => item.episode.id !== activeEpisodeId,
    );
    if (!next) {
      if (showEmptyNotice) showActionNotice("待播队列为空");
      return false;
    }
    playPodcastQueueItem(next);
    return true;
  }

  function appendToQueue(targetTracks: Track[]) {
    if (targetTracks.length === 0) return;
    setQueue((current) => uniqueIds([...current, ...targetTracks.map((track) => track.id)]));
    showActionNotice(`已添加 ${targetTracks.length} 首歌曲到正在播放`);
  }

  function addToPlaylist(playlistId: string, targetTracks: Track[]) {
    const ids = targetTracks.map((track) => track.id);
    if (ids.length === 0) return;
    const targetPlaylist = playlists.find((playlist) => playlist.id === playlistId);
    if (!targetPlaylist || isSmartPlaylist(targetPlaylist)) return;
    const addedCount = ids.filter((id) => !targetPlaylist.trackIds.includes(id)).length;

    setPlaylists((items) =>
      normalizePlaylists(items).map((playlist) =>
        playlist.id === playlistId && !isSmartPlaylist(playlist)
          ? { ...playlist, trackIds: uniqueIds([...playlist.trackIds, ...ids]) }
          : playlist,
      ),
    );
    showActionNotice(
      addedCount > 0
        ? `已添加 ${addedCount} 首歌曲到“${targetPlaylist.name}”`
        : `所选歌曲已在“${targetPlaylist.name}”中`,
    );
  }

  function removeFromPlaylist(playlistId: string, targetTracks: Track[]) {
    const ids = new Set(targetTracks.map((track) => track.id));
    if (ids.size === 0) return;

    setPlaylists((items) =>
      normalizePlaylists(items).map((playlist) =>
        playlist.id === playlistId && !isSmartPlaylist(playlist)
          ? { ...playlist, trackIds: playlist.trackIds.filter((id) => !ids.has(id)) }
          : playlist,
      ),
    );
  }

  function toggleFavorite() {
    if (activePodcastEpisode || !activeTrack) return;
    toggleFavoriteTrack(activeTrack);
  }

  function toggleFavoriteTrack(track: Track) {
    if (favoriteTrackIds.has(track.id)) {
      removeFromPlaylist(DEFAULT_PLAYLIST_ID, [track]);
    } else {
      addToPlaylist(DEFAULT_PLAYLIST_ID, [track]);
    }
  }

  // Page transitions play a short exit on the outgoing page before the new one
  // mounts (WP7 pivot/push/pop from `resolvePageTransition`). Navigating again
  // inside the exit window jumps straight to the latest target — no queueing.
  // `navTargetRef` records where an in-flight exit is heading so chrome (app
  // header, player bar) can start its own exit together with the old page
  // instead of lingering until the new page flips in.
  function requestNavigation(next: AppPage) {
    if (next === page) return;
    if (navExitTimerRef.current !== null) {
      window.clearTimeout(navExitTimerRef.current);
      navExitTimerRef.current = null;
      setNavExit(null);
      const interrupted = resolvePageTransition(page, next);
      setNavDir(interrupted.direction);
      setNavDrift({ enter: interrupted.enterDriftPx, exit: interrupted.exitDriftPx });
      navTargetRef.current = next;
      setPage(next);
      return;
    }
    const transition = resolvePageTransition(page, next);
    setNavDir(transition.direction);
    setNavDrift({ enter: transition.enterDriftPx, exit: transition.exitDriftPx });
    navTargetRef.current = next;
    if (transition.exitMs === 0) {
      setPage(next);
      return;
    }
    setNavExit(transition.direction);
    navExitTimerRef.current = window.setTimeout(() => {
      navExitTimerRef.current = null;
      setNavExit(null);
      setPage(next);
    }, resolveExitDurationMs(transition.exitMs, reducedMotion));
  }

  function clearCollectionSearch() {
    setQuery("");
    setSearchMode("results");
  }

  function setCollectionSearchQuery(value: string) {
    setQuery(value);
    setSearchMode("results");
  }

  function focusCollectionSearch() {
    if (page === "collection") {
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
      return;
    }
    focusSearchPendingRef.current = true;
    requestNavigation("collection");
  }

  function navigatePage(nextPage: "quickplay" | "collection" | "podcasts" | "settings") {
    if (nextPage !== "collection") {
      clearCollectionSearch();
    }
    requestNavigation(nextPage);
  }

  function navigateCollection(nextView: ViewMode) {
    setView(nextView);
    requestNavigation("collection");
  }

  function openSearchArtist(artist: string) {
    setSelectedArtistName(artist);
    setView("artists");
    setSearchMode("browse");
  }

  function openSearchAlbum(key: string) {
    setSelectedAlbumKey(key);
    setView("albums");
    setSearchMode("browse");
  }

  function openSearchPlaylist(playlistId: string) {
    setSelectedPlaylistId(playlistId);
    setView("playlists");
    setSearchMode("browse");
  }

  useEffect(() => {
    function handleCollectionSearchKeys(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        focusCollectionSearch();
        return;
      }

      if (event.key !== "Escape") return;
      if (contextMenu || infoTarget || playlistDialog || smartPlaylistDialog) return;

      if (resolveSearchSurface(query, searchMode) === "results") {
        event.preventDefault();
        clearCollectionSearch();
        return;
      }

      if (query.trim().length > 0 && searchMode === "browse") {
        event.preventDefault();
        setSearchMode("results");
      }
    }

    window.addEventListener("keydown", handleCollectionSearchKeys, true);
    return () => window.removeEventListener("keydown", handleCollectionSearchKeys, true);
  }, [contextMenu, infoTarget, page, playlistDialog, query, searchMode, smartPlaylistDialog]);

  function toggleHomePin(payload: ContextPayload) {
    const pin = homePinForPayload(payload);
    if (!pin) return;
    const isPinned = homePins.some((item) => item.id === pin.id);
    if (!isPinned && homePins.length >= MAX_HOME_PINS) {
      showActionNotice(`quickplay 最多固定 ${MAX_HOME_PINS} 项内容`);
      return;
    }

    setHomePins((current) => isPinned
      ? current.filter((item) => item.id !== pin.id)
      : [...current, pin]);
    showActionNotice(isPinned ? `已从 quickplay 取消固定“${payload.title}”` : `已固定“${payload.title}”到 quickplay`);
  }

  function openHomePin(pin: HomePin) {
    if (pin.kind === "track") {
      const track = tracks.find((item) => item.id === pin.targetId);
      if (track) playTrack(track, tracks);
      return;
    }
    if (pin.kind === "album") {
      setSelectedAlbumKey(pin.targetId);
      navigateCollection("albums");
      return;
    }
    if (pin.kind === "artist") {
      setSelectedArtistName(pin.targetId);
      navigateCollection("artists");
      return;
    }
    setSelectedPlaylistId(pin.targetId);
    navigateCollection("playlists");
  }

  function openNowPlaying() {
    if (!activePodcastEpisode && !activeTrack) return;
    if (page !== "nowPlaying") previousPageRef.current = page;
    requestNavigation("nowPlaying");
  }

  function createPlaylist(name: string) {
    const cleanName = name.trim();
    if (!cleanName) return;

    const playlist: Playlist = {
      id: `playlist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: cleanName,
      description: "自定义播放列表",
      kind: "manual",
      trackIds: [],
    };

    setPlaylists((items) => [...normalizePlaylists(items), playlist]);
    setSelectedPlaylistId(playlist.id);
    setView("playlists");
    showActionNotice(`已创建播放列表“${playlist.name}”`);
  }

  function renamePlaylist(playlistId: string, name: string) {
    const cleanName = name.trim();
    if (!cleanName || playlistId === DEFAULT_PLAYLIST_ID) return;

    setPlaylists((items) =>
      normalizePlaylists(items).map((playlist) =>
        playlist.id === playlistId && !isSmartPlaylist(playlist) ? { ...playlist, name: cleanName } : playlist,
      ),
    );
    showActionNotice(`播放列表已重命名为“${cleanName}”`);
  }

  function deletePlaylist(playlistId: string) {
    if (playlistId === DEFAULT_PLAYLIST_ID) return;
    const playlist = playlists.find((item) => item.id === playlistId);
    if (!playlist) return;

    setPlaylists((items) => normalizePlaylists(items).filter((item) => item.id !== playlistId));
    setSelectedPlaylistId((current) => current === playlistId ? DEFAULT_PLAYLIST_ID : current);
    showActionNotice(`已删除播放列表“${playlist.name}”`);
  }

  function showActionNotice(message: string) {
    setActionNotice(message);
    if (actionNoticeTimerRef.current) window.clearTimeout(actionNoticeTimerRef.current);
    actionNoticeTimerRef.current = window.setTimeout(() => {
      setActionNotice(null);
      actionNoticeTimerRef.current = null;
    }, 2_400);
  }

  function openCreatePlaylistDialog() {
    setPlaylistDialog({ mode: "create", playlistName: "" });
  }

  function openCreateSmartPlaylist() {
    setPlaylistDialog(null);
    setSmartPlaylistDialog("create");
  }

  function openSmartPlaylistEditor(playlistId: string) {
    const playlist = playlists.find((item) => item.id === playlistId);
    if (!playlist || !isSmartPlaylist(playlist)) return;
    setPlaylistDialog(null);
    setSmartPlaylistDialog(playlist);
  }

  function saveSmartPlaylist(draft: SmartPlaylistDraft) {
    if (smartPlaylistDialog === "create") {
      const playlist: SmartPlaylist = {
        id: `smart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        kind: "smart",
        ...draft,
      };
      setPlaylists((items) => [...normalizePlaylists(items), playlist]);
      setSelectedPlaylistId(playlist.id);
      setView("playlists");
      showActionNotice(`已创建智能播放列表“${playlist.name}”`);
    } else if (smartPlaylistDialog) {
      setPlaylists((items) => normalizePlaylists(items).map((playlist) =>
        playlist.id === smartPlaylistDialog.id && isSmartPlaylist(playlist)
          ? { ...playlist, ...draft }
          : playlist,
      ));
      showActionNotice(`已更新智能播放列表“${draft.name}”`);
    }
    setSmartPlaylistDialog(null);
  }

  function refreshSmartPlaylist(playlistId: string) {
    setPlaylists((items) => normalizePlaylists(items).map((playlist) =>
      playlist.id === playlistId && isSmartPlaylist(playlist)
        ? { ...playlist, smart: { ...playlist.smart, rotationSeed: playlist.smart.rotationSeed + 1 } }
        : playlist,
    ));
    showActionNotice("已换一批歌曲");
  }

  function excludeFromSmartPlaylist(playlistId: string, targetTracks: Track[]) {
    const ids = targetTracks.map((track) => track.id);
    if (ids.length === 0) return;
    setPlaylists((items) => normalizePlaylists(items).map((playlist) =>
      playlist.id === playlistId && isSmartPlaylist(playlist)
        ? { ...playlist, excludedTrackIds: uniqueIds([...playlist.excludedTrackIds, ...ids]) }
        : playlist,
    ));
    showActionNotice(`已从智能列表中排除 ${ids.length} 首歌曲`);
  }

  function openPlaylistDialog(mode: "rename" | "delete", playlistId: string) {
    const playlist = playlists.find((item) => item.id === playlistId);
    if (!playlist || playlist.id === DEFAULT_PLAYLIST_ID) return;
    if (mode === "rename" && isSmartPlaylist(playlist)) {
      openSmartPlaylistEditor(playlistId);
      return;
    }
    setPlaylistDialog({ mode, playlistId, playlistName: playlist.name });
  }

  function submitPlaylistDialog(name: string) {
    if (!playlistDialog) return;
    if (playlistDialog.mode === "create") createPlaylist(name);
    if (playlistDialog.mode === "rename" && playlistDialog.playlistId) {
      renamePlaylist(playlistDialog.playlistId, name);
    }
    if (playlistDialog.mode === "delete" && playlistDialog.playlistId) {
      deletePlaylist(playlistDialog.playlistId);
    }
    setPlaylistDialog(null);
  }

  function saveQueueAsPlaylist(name: string) {
    const cleanName = name.trim();
    const trackIds = uniqueIds(playbackQueueIds);
    if (!cleanName || trackIds.length === 0) return;

    const playlist: Playlist = {
      id: `playlist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: cleanName,
      description: "自定义播放列表",
      kind: "manual",
      trackIds,
    };

    setPlaylists((items) => [...normalizePlaylists(items), playlist]);
  }

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

  function closeContextMenu() {
    setContextMenu(null);
  }

  function persistPodcastProgress(currentTime: number, trackDuration: number, force = false) {
    const episode = activePodcastEpisodeRef.current;
    if (!episode) return Promise.resolve();
    const positionSeconds = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
    const durationSeconds = Number.isFinite(trackDuration) ? Math.max(0, trackDuration) : 0;
    const now = Date.now();
    const previous = podcastProgressSaveRef.current;
    if (
      !force
      && previous?.episodeId === episode.episodeId
      && now - previous.savedAt < PODCAST_PROGRESS_SAVE_INTERVAL_MS
    ) {
      return podcastProgressMutationRef.current;
    }
    if (
      force
      && previous?.episodeId === episode.episodeId
      && Math.abs(previous.position - positionSeconds) < 0.25
      && Math.abs(previous.duration - durationSeconds) < 0.25
    ) {
      return podcastProgressMutationRef.current;
    }

    podcastProgressSaveRef.current = {
      episodeId: episode.episodeId,
      savedAt: now,
      position: positionSeconds,
      duration: durationSeconds,
    };
    const save = podcastProgressMutationRef.current.then(() =>
      invoke("podcast_save_progress", {
        episodeId: episode.episodeId,
        positionSeconds,
        durationSeconds,
      })
    );
    podcastProgressMutationRef.current = save.then(
      () => undefined,
      (reason) => {
        if (import.meta.env.DEV) console.warn("[podcast] progress save failed", reason);
      },
    );
    return podcastProgressMutationRef.current;
  }

  function flushPodcastProgress() {
    const audio = audioRef.current;
    if (!audio) return Promise.resolve();
    const episode = activePodcastEpisodeRef.current;
    const pending = pendingPodcastResumeRef.current;
    const resumePending = Boolean(
      episode
      && pending
      && pending.episodeId === episode.episodeId,
    );
    const currentTime = resumePending ? pending!.position : audio.currentTime;
    const trackDuration = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : episode?.durationSeconds ?? 0;
    return persistPodcastProgress(currentTime, trackDuration, true);
  }

  function handleLoadedMetadata(audio: HTMLAudioElement) {
    const nextDuration = Number.isFinite(audio.duration) ? Math.max(0, audio.duration) : 0;
    setDuration(nextDuration);
    const pending = pendingPodcastResumeRef.current;
    const episode = activePodcastEpisodeRef.current;
    if (!pending || !episode || pending.episodeId !== episode.episodeId) return;
    pendingPodcastResumeRef.current = null;
    const resumePosition = !episode.completed && pending.position > 0 && (
      nextDuration <= 0 || pending.position < Math.max(0, nextDuration - 5)
    )
      ? Math.min(pending.position, nextDuration || pending.position)
      : 0;
    if (resumePosition > 0) audio.currentTime = resumePosition;
    setProgress(resumePosition);
  }

  function handleAudioPause() {
    setIsPlaying(false);
    if (activePodcastEpisodeRef.current) {
      setPodcastPlaybackStatus(
        podcastPlaybackIntentRef.current ? "loading" : "paused",
      );
    }
  }

  function handleAudioError() {
    setIsPlaying(false);
    if (activePodcastEpisodeRef.current) {
      setPodcastPlaybackStatus("error");
      showActionNotice("播放失败，请检查网络或重新下载");
    }
  }

  function handleAudioLoadStart() {
    if (activePodcastEpisodeRef.current) setPodcastPlaybackStatus("loading");
  }

  function handleAudioWaiting() {
    if (activePodcastEpisodeRef.current) {
      setPodcastPlaybackStatus(
        podcastPlaybackIntentRef.current ? "buffering" : "paused",
      );
    }
  }

  function handleAudioCanPlay() {
    if (!activePodcastEpisodeRef.current) return;
    if (!podcastPlaybackIntentRef.current) {
      setPodcastPlaybackStatus("paused");
      return;
    }
    setPodcastPlaybackStatus(audioRef.current?.paused ? "loading" : "playing");
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio || !activePlayback) return;

    if (audio.paused) {
      const sourceKey = activeAudioSourceKeyRef.current;
      const playAttempt = audioPlayAttemptRef.current + 1;
      audioPlayAttemptRef.current = playAttempt;
      const podcastEpisodeId = activePodcastEpisodeRef.current?.episodeId ?? null;
      if (podcastEpisodeId) podcastPlaybackIntentRef.current = true;
      void audio.play().then(() => {
        if (
          activeAudioSourceKeyRef.current !== sourceKey
          || audioPlayAttemptRef.current !== playAttempt
        ) return;
        setIsPlaying(true);
        if (podcastEpisodeId) {
          podcastPlaybackStartedEpisodeRef.current = podcastEpisodeId;
          setPodcastPlaybackStatus("playing");
          consumePendingPodcastQueueEpisode(podcastEpisodeId);
        }
        void resumeAudioGraph();
      }).catch(() => {
        if (
          activeAudioSourceKeyRef.current !== sourceKey
          || audioPlayAttemptRef.current !== playAttempt
        ) return;
        setIsPlaying(false);
        if (activePodcastEpisodeRef.current) setPodcastPlaybackStatus("error");
      });
    } else {
      flushPodcastProgress();
      if (activePodcastEpisodeRef.current) podcastPlaybackIntentRef.current = false;
      audioPlayAttemptRef.current += 1;
      audio.pause();
      setIsPlaying(false);
    }
  }

  function retryPodcastPlayback() {
    const audio = audioRef.current;
    const episode = activePodcastEpisodeRef.current;
    if (!audio || !episode) return;
    const currentPosition = Number.isFinite(audio.currentTime)
      ? Math.max(0, audio.currentTime)
      : 0;
    const resumePosition = currentPosition > 0 ? currentPosition : progress;
    const sourceKey = activeAudioSourceKeyRef.current;
    const playAttempt = audioPlayAttemptRef.current + 1;
    audioPlayAttemptRef.current = playAttempt;
    persistPodcastProgress(resumePosition, audio.duration, true);
    pendingPodcastResumeRef.current = {
      episodeId: episode.episodeId,
      position: resumePosition,
    };
    podcastPlaybackIntentRef.current = true;
    setPodcastPlaybackStatus("loading");
    audio.load();
    void audio.play().then(() => {
      if (
        activeAudioSourceKeyRef.current !== sourceKey
        || audioPlayAttemptRef.current !== playAttempt
      ) return;
      setIsPlaying(true);
      podcastPlaybackStartedEpisodeRef.current = episode.episodeId;
      setPodcastPlaybackStatus("playing");
      consumePendingPodcastQueueEpisode(episode.episodeId);
      void resumeAudioGraph();
    }).catch(() => {
      if (
        activeAudioSourceKeyRef.current !== sourceKey
        || audioPlayAttemptRef.current !== playAttempt
      ) return;
      setIsPlaying(false);
      setPodcastPlaybackStatus("error");
    });
  }

  function restartCurrentPlayback() {
    const audio = audioRef.current;
    if (!audio || activePodcastEpisode || !activeTrack) return;
    audio.currentTime = 0;
    setProgress(0);
    playbackSessionRef.current = {
      trackId: activeTrack.id,
      maxProgress: 0,
      countedPlay: false,
      countedComplete: false,
    };
    const sourceKey = activeAudioSourceKeyRef.current;
    const playAttempt = audioPlayAttemptRef.current + 1;
    audioPlayAttemptRef.current = playAttempt;
    void audio
      .play()
      .then(() => {
        if (
          activeAudioSourceKeyRef.current !== sourceKey
          || audioPlayAttemptRef.current !== playAttempt
        ) return;
        setIsPlaying(true);
        void resumeAudioGraph();
      })
      .catch(() => {
        if (
          activeAudioSourceKeyRef.current !== sourceKey
          || audioPlayAttemptRef.current !== playAttempt
        ) return;
        setIsPlaying(false);
      });
  }

  function ensureAudioGraph() {
    if (visualizerUnavailableRef.current) return;

    const audio = audioRef.current;
    if (!audio) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      visualizerUnavailableRef.current = true;
      return;
    }

    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContextClass();
      }

      if (!analyserRef.current) {
        const analyser = audioContextRef.current.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.78;
        analyserRef.current = analyser;
      }

      if (!audioSourceRef.current) {
        audioSourceRef.current = audioContextRef.current.createMediaElementSource(audio);
        audioSourceRef.current.connect(analyserRef.current);
      }

      if (!outputGainRef.current) {
        const outputGain = audioContextRef.current.createGain();
        outputGain.gain.value = 1;
        analyserRef.current.connect(outputGain);
        outputGain.connect(audioContextRef.current.destination);
        outputGainRef.current = outputGain;
      }

      if (audioContextRef.current.state === "suspended") {
        void audioContextRef.current.resume();
      }
    } catch (error) {
      console.warn("Audio visualizer disabled", error);
      visualizerUnavailableRef.current = true;
    }
  }

  async function resumeAudioGraph() {
    if (!audioRef.current || visualizerUnavailableRef.current) return;

    ensureAudioGraph();
    if (audioContextRef.current?.state === "suspended") {
      await audioContextRef.current.resume().catch(() => undefined);
    }
  }

  async function preAnalyzeBeatGrid(track: Track) {
    if (beatGridCacheRef.current.has(track.id)) {
      offlineBeatGridRef.current = beatGridCacheRef.current.get(track.id) ?? null;
      return;
    }

    const requestId = beatAnalysisRequestRef.current + 1;
    beatAnalysisRequestRef.current = requestId;

    try {
      const sourceUrl = convertFileSrc(track.path, "zone-audio");
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error(`beat analysis fetch failed: ${response.status}`);
      const bytes = await response.arrayBuffer();
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("AudioContext unavailable");
      const context = audioContextRef.current ?? new AudioContextClass();
      const shouldClose = !audioContextRef.current;
      const buffer = await context.decodeAudioData(bytes.slice(0));
      const mixed = mixAudioBuffer(buffer);
      const grid = analyzePcmBeatGrid(mixed, buffer.sampleRate);
      beatGridCacheRef.current.set(track.id, grid);
      if (shouldClose) void context.close();
      if (beatAnalysisRequestRef.current === requestId && activeTrackId === track.id) {
        offlineBeatGridRef.current = grid;
      }
    } catch {
      beatGridCacheRef.current.set(track.id, null);
      if (beatAnalysisRequestRef.current === requestId && activeTrackId === track.id) {
        offlineBeatGridRef.current = null;
      }
    }
  }

  function mixAudioBuffer(buffer: AudioBuffer) {
    const length = buffer.length;
    const channels = Math.min(2, buffer.numberOfChannels);
    if (channels <= 1) return new Float32Array(buffer.getChannelData(0));

    const mixed = new Float32Array(length);
    for (let channel = 0; channel < channels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < length; index += 1) mixed[index] += data[index] / channels;
    }
    return mixed;
  }

  // Keep the bus frame's beat fields at idle (samples/energy untouched) while
  // playback is paused or switching tracks, mirroring the old beatFrame reset.
  function publishIdleBeatFrame() {
    const current = getVisualizerFrame();
    publishVisualizerFrame({
      ...current,
      beatPulse: 0,
      beatPhase: 0,
      onsetStrength: 0,
      beatConfidence: 0,
    });
  }

  function publishPodcastVisualizerReset() {
    publishVisualizerFrame({
      samples: Array.from({ length: VISUALIZER_SAMPLE_COUNT }, () => 0.035),
      energy: 0.055,
      beatPulse: 0,
      beatPhase: 0,
      onsetStrength: 0,
      beatConfidence: 0,
    });
  }

  function startVisualizer() {
    void resumeAudioGraph();
    const frequencyData = new Uint8Array(analyserRef.current?.frequencyBinCount ?? 512);
    const timeData = new Uint8Array(analyserRef.current?.fftSize ?? 1024);
    const sample = () => {
      const analyser = analyserRef.current;
      let frame = createIdleVisualizerFrame(
        VISUALIZER_SAMPLE_COUNT,
        performance.now() * 0.001,
        audioRef.current?.currentTime ?? progress,
      );
      let beat = beatFrameRef.current;

      if (analyser && !visualizerUnavailableRef.current) {
        analyser.getByteFrequencyData(frequencyData);
        analyser.getByteTimeDomainData(timeData);
        const audioFrame = createAudioVisualizerFrame(
          frequencyData,
          timeData,
          VISUALIZER_SAMPLE_COUNT,
          audioContextRef.current?.sampleRate,
          analyser.fftSize,
        );
        visualizerSilenceFramesRef.current = audioFrame.active ? 0 : visualizerSilenceFramesRef.current + 1;
        if (visualizerSilenceFramesRef.current < 28) frame = audioFrame;

        if (!realtimeBeatRef.current) realtimeBeatRef.current = new RealtimeBeatAnalyzer();
        beat = realtimeBeatRef.current.update(
          frequencyData,
          timeData,
          audioRef.current?.currentTime ?? progress,
          audioContextRef.current?.sampleRate,
          analyser.fftSize,
          offlineBeatGridRef.current,
        );
        beatFrameRef.current = beat;
      }

      const previousEnergy = visualizerEnergyRef.current;
      const energy = frame.energy > previousEnergy
        ? previousEnergy * 0.64 + frame.energy * 0.36
        : previousEnergy * 0.9 + frame.energy * 0.1;
      visualizerEnergyRef.current = energy;

      if (visualizerSamplesRef.current.length !== VISUALIZER_SAMPLE_COUNT) {
        visualizerSamplesRef.current = Array.from({ length: VISUALIZER_SAMPLE_COUNT }, () => 0.035);
      }
      const samples = visualizerSamplesRef.current.map((previous, index) => {
        const next = frame.samples[index] ?? 0.035;
        return next > previous
          ? previous * 0.58 + next * 0.42
          : previous * 0.9 + next * 0.1;
      });
      visualizerSamplesRef.current = samples;

      publishVisualizerFrame({
        samples,
        energy,
        beatPulse: beat.beatPulse,
        beatPhase: beat.beatPhase,
        onsetStrength: beat.onsetStrength,
        beatConfidence: beat.confidence,
      });
      visualizerFrameRef.current = requestAnimationFrame(sample);
    };

    sample();
  }

  function updateTrackActivity(trackId: string, update: (current: ReturnType<typeof createTrackActivity>) => ReturnType<typeof createTrackActivity>) {
    setTrackActivity((current) => ({
      ...current,
      [trackId]: update(createTrackActivity(current[trackId])),
    }));
  }

  function markEffectivePlay() {
    const session = playbackSessionRef.current;
    if (!session || session.countedPlay) return;
    session.countedPlay = true;
    updateTrackActivity(session.trackId, (current) => ({
      ...current,
      playCount: current.playCount + 1,
      lastPlayedAt: Date.now(),
    }));
  }

  function markCompletedPlayback() {
    const session = playbackSessionRef.current;
    if (!session || session.countedComplete) return;
    if (!session.countedPlay) markEffectivePlay();
    session.countedComplete = true;
    updateTrackActivity(session.trackId, (current) => ({
      ...current,
      completedCount: current.completedCount + 1,
      lastPlayedAt: Date.now(),
    }));
  }

  function recordSkipIfEligible() {
    const session = playbackSessionRef.current;
    if (!session || session.countedPlay || session.maxProgress < 3) return;
    const trackDuration = audioRef.current?.duration || duration;
    if (trackDuration > 0 && session.maxProgress / trackDuration >= 0.5) return;
    session.countedPlay = true;
    updateTrackActivity(session.trackId, (current) => ({
      ...current,
      skipCount: current.skipCount + 1,
      lastSkippedAt: Date.now(),
    }));
  }

  function handleTimeUpdate(currentTime: number, trackDuration: number) {
    const podcastEpisode = activePodcastEpisodeRef.current;
    if (podcastEpisode) {
      const pending = pendingPodcastResumeRef.current;
      if (pending?.episodeId === podcastEpisode.episodeId) {
        setProgress(Math.max(0, pending.position));
        return;
      }
      setProgress(currentTime);
      persistPodcastProgress(currentTime, trackDuration);
      return;
    }
    setProgress(currentTime);
    const session = playbackSessionRef.current;
    if (!session || session.trackId !== activeTrackId) return;
    session.maxProgress = Math.max(session.maxProgress, currentTime);
    const threshold = trackDuration > 0
      ? Math.min(240, Math.max(30, trackDuration * 0.5))
      : 30;
    if (currentTime >= threshold) markEffectivePlay();
  }

  function move(delta: 1 | -1, reason: "user" | "ended" = "user"): QueueMoveResult {
    cancelPodcastSessionRestore();
    if (activePodcastEpisode) return { kind: "boundary" };
    if (baseQueueIds.length === 0) return { kind: "empty" };
    if (delta === 1 && reason === "user") recordSkipIfEligible();

    let playbackOrder = playbackQueueIds;
    if (shuffle && !haveSameQueueItems(shuffleOrder, baseQueueIds)) {
      playbackOrder = createShuffleOrder(baseQueueIds, activeTrackId);
      setShuffleOrder(playbackOrder);
    }
    const activeIndex = playbackOrder.indexOf(activeTrackId ?? "");
    if (shuffle && repeat === "all" && delta === 1 && activeIndex === playbackOrder.length - 1 && playbackOrder.length > 1) {
      playbackOrder = createShuffleOrder(baseQueueIds, activeTrackId);
      setShuffleOrder(playbackOrder);
    }

    const result = resolveQueueMove(playbackOrder, activeTrackId, delta, repeat);
    if (result.kind === "restart") restartCurrentPlayback();
    if (result.kind === "move") setActiveTrackId(result.trackId);
    return result;
  }

  function onEnded() {
    if (activePodcastEpisodeRef.current) {
      const audio = audioRef.current;
      const progressSaved = audio
        ? persistPodcastProgress(audio.duration, audio.duration, true)
        : Promise.resolve();
      setActivePodcastEpisode((current) => current
        ? {
            ...current,
            completed: true,
            progressSeconds: audio?.duration || current.durationSeconds || current.progressSeconds,
          }
        : current
      );
      void progressSaved.finally(() => {
        setPodcastLibraryRevision((current) => current + 1);
      });
      setIsPlaying(false);
      if (
        podcastSleepTimer?.kind === "episodeEnd"
        && podcastSleepTimer.episodeId === activePodcastEpisodeRef.current.episodeId
      ) {
        podcastPlaybackIntentRef.current = false;
        setPodcastSleepTimer(null);
        setPodcastPlaybackStatus("paused");
        showActionNotice("已在本集结束后暂停");
        return;
      }
      if (playNextPodcastEpisode(false)) return;
      podcastPlaybackIntentRef.current = false;
      setPodcastPlaybackStatus("paused");
      return;
    }
    markCompletedPlayback();
    if (repeat === "one" && audioRef.current) {
      restartCurrentPlayback();
      return;
    }

    const result = move(1, "ended");
    if (result.kind === "boundary" || result.kind === "empty") {
      setIsPlaying(false);
    }
  }

  function seek(value: number) {
    if (!audioRef.current) return;
    const podcastEpisode = activePodcastEpisodeRef.current;
    if (pendingPodcastResumeRef.current?.episodeId === podcastEpisode?.episodeId) {
      pendingPodcastResumeRef.current = null;
    }
    audioRef.current.currentTime = value;
    setProgress(value);
    if (activePodcastEpisodeRef.current) {
      persistPodcastProgress(value, audioRef.current.duration, true);
    }
  }

  useSystemMedia({
    media: systemMediaItem,
    isPlaying,
    canPrevious: activePodcastEpisode ? true : canMovePrevious,
    canNext: activePodcastEpisode
      ? podcastQueue.some((item) => item.episode.id !== activePodcastEpisode.episodeId)
      : canMoveNext,
    duration,
    position: progress,
    isFavorite: activePodcastEpisode ? false : isActiveTrackFavorite,
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
      if (!activePodcastEpisode) toggleFavorite();
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
      playlists={playlists}
      onClose={closeContextMenu}
      onPlay={() => playContextPayload(contextMenu.payload)}
      onAddToQueue={() => appendToQueue(contextMenu.payload.tracks)}
      onAddToPlaylist={(playlistId) => addToPlaylist(playlistId, contextMenu.payload.tracks)}
      onRenamePlaylist={(playlistId) => openPlaylistDialog("rename", playlistId)}
      onDeletePlaylist={(playlistId) => openPlaylistDialog("delete", playlistId)}
      onExcludeFromSmartPlaylist={(playlistId) => excludeFromSmartPlaylist(playlistId, contextMenu.payload.tracks)}
      homePinState={homePinStateForPayload(homePins, contextMenu.payload)}
      onToggleHomePin={() => toggleHomePin(contextMenu.payload)}
      onInfo={() => setInfoTarget(contextMenu.payload)}
    />
  ) : null;
  const infoPanelElement = infoTarget ? (
    <InfoPanel payload={infoTarget} onClose={() => setInfoTarget(null)} />
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
  const actionToastElement = actionNotice ? (
    <div className="action-toast" role="status">{actionNotice}</div>
  ) : null;
  const showSearchResults = resolveSearchSurface(query, searchMode) === "results";
  const lastAppHeaderElement = useLastNonNull(appHeaderElement);
  const lastPlayerBarElement = useLastNonNull(playerBarElement);
  const lastContextMenuElement = useLastNonNull(contextMenuElement);
  const lastInfoPanelElement = useLastNonNull(infoPanelElement);
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
          if (activePodcastEpisodeRef.current) {
            setPodcastPlaybackStatus("playing");
          }
        }}
        onPause={handleAudioPause}
        onWaiting={handleAudioWaiting}
        onStalled={handleAudioWaiting}
        onCanPlay={handleAudioCanPlay}
        onError={handleAudioError}
        onEnded={onEnded}
      />
      <Titlebar
        isSettings={page === "settings"}
        onOpenSettings={() => navigatePage("settings")}
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
            onOpenPin={openHomePin}
            onMovePin={(sourceId, targetId) => setHomePins((current) => moveHomePin(current, sourceId, targetId))}
            onShiftPin={(pinId, direction) => setHomePins((current) => shiftHomePin(current, pinId, direction))}
            onTogglePin={toggleHomePin}
            onContextMenu={showContextMenu}
          />
        ) : null}

        {page === "collection" && (
          <section
            className={`content-band collection-band${showSearchResults ? " collection-searching" : ""}`}
          >
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
            isPlaying={isPlaying && Boolean(activePodcastEpisode)}
            queue={podcastQueue}
            episodeRequest={podcastEpisodeRequest}
            onEpisodeRequestHandled={(nonce) => {
              setPodcastEpisodeRequest((current) =>
                current?.nonce === nonce ? null : current
              );
            }}
            onPlayEpisode={playPodcastEpisode}
            onQueueEpisode={queuePodcastEpisode}
            onRemoveQueueEpisode={removePodcastQueueEpisode}
            onMoveQueueEpisode={movePodcastQueueEpisode}
            onClearQueue={clearPodcastQueue}
            onEpisodeUpdated={updatePodcastEpisode}
            onSetEpisodePlayed={setPodcastEpisodePlayed}
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
                const item = podcastQueueRef.current.find((candidate) => candidate.episode.id === episodeId);
                if (item) playPodcastQueueItem(item);
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
            onAddFolder={addFolder}
            onRescan={() => rescan()}
            onClear={() => {
              setFolders([]);
              setTracks([]);
              setQueue([]);
              setTrackActivity({});
              setActiveTrackId(null);
              setScanNote("");
              localStorage.removeItem(STORAGE_KEY);
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
