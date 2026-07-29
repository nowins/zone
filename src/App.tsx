import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Titlebar } from "./components/Titlebar";
import { AppHeader } from "./components/AppHeader";
import { CollectionSearchField } from "./components/CollectionSearchField";
import { EmptyState } from "./components/EmptyState";
import { PlayerBar } from "./components/PlayerBar";
import { PodcastPlayerBar } from "./components/PodcastPlayerBar";
import { ContextMenu } from "./components/ContextMenu";
import { InfoPanel } from "./components/InfoPanel";
import { PlaylistDialog, type PlaylistDialogState } from "./components/PlaylistDialog";
import { SmartPlaylistDialog } from "./components/SmartPlaylistDialog";
import { LibraryView } from "./views/LibraryView";
import { SearchResultsView } from "./views/SearchResultsView";
import { QuickplayView } from "./views/QuickplayView";
import { NowPlayingView } from "./views/NowPlayingView";
import { PodcastNowPlayingView } from "./views/PodcastNowPlayingView";
import { SettingsView } from "./views/SettingsView";
import { PodcastView } from "./views/PodcastView";
import { DEFAULT_PLAYLIST_ID, LIBRARY_SCHEMA_VERSION, STORAGE_KEY } from "./constants";
import { formatCollectionPlaylistCount, normalizePlaylists } from "./utils/music";
import { homePinStateForPayload, moveHomePin, normalizeHomePins, shiftHomePin } from "./utils/homePins";
import { resolveSearchSurface } from "./utils/collectionSearch";
import { useSystemMedia } from "./hooks/useSystemMedia";
import { useNavigation, type NowPlayingTargets } from "./hooks/useNavigation";
import { useMusicLibrary } from "./hooks/useMusicLibrary";
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
  const [playlistDialog, setPlaylistDialog] = useState<PlaylistDialogState | null>(null);
  const [smartPlaylistDialog, setSmartPlaylistDialog] = useState<SmartPlaylist | "create" | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
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
  const podcast = usePodcastPlayback({
    audioRef,
    showActionNotice,
    requestNavigation,
    playbackControlsRef,
    playbackSessionRef,
  });
  const {
    activePodcastEpisode,
    activePodcastEpisodeRef,
    podcastQueue,
    podcastQueueRef,
    podcastLibraryRevision,
    podcastEpisodeRequest,
    setPodcastEpisodeRequest,
    podcastPlaybackRate,
    setPodcastPlaybackRate,
    podcastAutoQueueMode,
    podcastSleepTimer,
    setPodcastSleepTimer,
    podcastSleepTimerRef,
    podcastPlaybackStatus,
    setPodcastPlaybackStatus,
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
    playPodcastQueueItem,
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
  } = usePlaybackControls({
    audioRef,
    showActionNotice,
    audioEngineRef,
    playbackSessionRef,
    tracks,
    restored,
    setTrackActivity,
    activeTrackId,
    setActiveTrackId,
    queue,
    setQueue,
    playHistory,
    setPlayHistory,
    podcast,
  });
  playbackControlsRef.current = { seek, togglePlay };
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
    if (podcastSleepTimerRef.current !== null) window.clearTimeout(podcastSleepTimerRef.current);
    void flushPodcastProgress();
  }, []);

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
            autoQueueMode={podcastAutoQueueMode}
            isPlaying={isPlaying && Boolean(activePodcastEpisode)}
            queue={podcastQueue}
            episodeRequest={podcastEpisodeRequest}
            onEpisodeRequestHandled={(nonce) => {
              setPodcastEpisodeRequest((current) =>
                current?.nonce === nonce ? null : current
              );
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
