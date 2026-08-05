import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
} from "./app/musicLibraryApi";
import { formatCollectionPlaylistCount, normalizePlaylists } from "./utils/music";
import { seedFromTracks } from "./utils/smartDj";
import { homePinStateForPayload, moveHomePin, normalizeHomePins, shiftHomePin } from "./utils/homePins";
import { resolveSearchSurface } from "./utils/collectionSearch";
import { useSystemMedia } from "./hooks/useSystemMedia";
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
  SmartPlaylist,
  Track,
  ViewMode,
} from "./types";

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
    openHomePin,
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
    playTrack,
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
          try {
            const legacy = JSON.parse(saved);
            snapshot = await musicImportLegacyPlayerState(legacy);
            localStorage.removeItem(STORAGE_KEY);
          } catch (error) {
            if (import.meta.env.DEV) console.warn("[library] legacy import failed", error);
            localStorage.removeItem(STORAGE_KEY);
          }
        } else if (saved) {
          // DB is source of truth once populated.
          localStorage.removeItem(STORAGE_KEY);
        }

        if (cancelled) return;

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
            localStorage.removeItem(STORAGE_KEY);
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
    if (!restored) return;
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
    if (!restored) return;
    const timer = window.setTimeout(() => {
      void musicSaveTrackActivity(trackActivity).catch((error) => {
        if (import.meta.env.DEV) console.warn("[library] save track activity failed", error);
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [restored, trackActivity]);

  useEffect(() => {
    if (!restored) return;
    const timer = window.setTimeout(() => {
      void musicSavePlaylists(playlists).catch((error) => {
        if (import.meta.env.DEV) console.warn("[library] save playlists failed", error);
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [restored, playlists]);

  useEffect(() => {
    if (!restored) return;
    const timer = window.setTimeout(() => {
      void musicSaveHomePins(homePins).catch((error) => {
        if (import.meta.env.DEV) console.warn("[library] save home pins failed", error);
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [restored, homePins]);

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
  }

  function closeContextMenu() {
    setContextMenu(null);
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
      onClose={closeContextMenu}
      onPlay={() => playContextPayload(contextMenu.payload)}
      onPlayNext={() => playNext(contextMenu.payload.tracks)}
      onAddToQueue={() => appendToQueue(contextMenu.payload.tracks)}
      onStartSmartDj={() => startSmartDjFromPayload(contextMenu.payload)}
      onAddToPlaylist={() => setAddToPlaylistTarget(contextMenu.payload)}
      onAddToFavorites={() => addToPlaylist(DEFAULT_PLAYLIST_ID, contextMenu.payload.tracks)}
      onRenamePlaylist={(playlistId) => openPlaylistDialog("rename", playlistId)}
      onDeletePlaylist={(playlistId) => openPlaylistDialog("delete", playlistId)}
      onExcludeFromSmartPlaylist={(playlistId) => excludeFromSmartPlaylist(playlistId, contextMenu.payload.tracks)}
      homePinState={homePinStateForPayload(homePins, contextMenu.payload)}
      onToggleHomePin={() => toggleHomePin(contextMenu.payload)}
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
  const actionToastElement = actionNotice ? (
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
            onAddFolder={addFolder}
            onRescan={() => rescan()}
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
