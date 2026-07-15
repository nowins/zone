import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Titlebar } from "./components/Titlebar";
import { AppHeader } from "./components/AppHeader";
import { EmptyState } from "./components/EmptyState";
import { PlayerBar } from "./components/PlayerBar";
import { ContextMenu } from "./components/ContextMenu";
import { InfoPanel } from "./components/InfoPanel";
import { LibraryView } from "./views/LibraryView";
import { QuickplayView } from "./views/QuickplayView";
import { NowPlayingView } from "./views/NowPlayingView";
import { SettingsView } from "./views/SettingsView";
import { DEFAULT_PLAYLIST_ID, LIBRARY_SCHEMA_VERSION, STORAGE_KEY, VISUALIZER_SAMPLE_COUNT } from "./constants";
import { albumKey, bestAlbumArtist, compareTracksForAlbum, defaultPlaylists, normalizePlaylists, uniqueIds } from "./utils/music";
import { analyzePcmBeatGrid, createIdleBeatFrame, RealtimeBeatAnalyzer, type BeatFrame, type BeatGrid } from "./utils/beatAnalysis";
import { createAudioVisualizerFrame, createIdleVisualizerFrame } from "./utils/visualizer";
import type { AlbumGroup, AppPage, ArtistGroup, ContextMenuState, ContextPayload, MusicFolder, Playlist, RepeatMode, ScanResult, Track, ViewMode } from "./types";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export default function App() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previousPageRef = useRef<"quickplay" | "collection" | "settings">("quickplay");
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const outputGainRef = useRef<GainNode | null>(null);
  const visualizerFrameRef = useRef<number | null>(null);
  const visualizerSilenceFramesRef = useRef(0);
  const visualizerUnavailableRef = useRef(false);
  const realtimeBeatRef = useRef<RealtimeBeatAnalyzer | null>(null);
  const offlineBeatGridRef = useRef<BeatGrid | null>(null);
  const beatGridCacheRef = useRef(new Map<string, BeatGrid | null>());
  const beatAnalysisRequestRef = useRef(0);
  const [folders, setFolders] = useState<MusicFolder[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>("albums");
  const [page, setPage] = useState<AppPage>("quickplay");
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [playHistory, setPlayHistory] = useState<string[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanNote, setScanNote] = useState("");
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [visualizerSamples, setVisualizerSamples] = useState<number[]>(() =>
    Array.from({ length: VISUALIZER_SAMPLE_COUNT }, () => 0.035),
  );
  const [visualizerEnergy, setVisualizerEnergy] = useState(0.055);
  const [beatFrame, setBeatFrame] = useState<BeatFrame>(() => createIdleBeatFrame());
  const [restored, setRestored] = useState(false);
  const [needsMetadataRefresh, setNeedsMetadataRefresh] = useState(false);
  const [selectedAlbumKey, setSelectedAlbumKey] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>(defaultPlaylists());
  const [selectedPlaylistId, setSelectedPlaylistId] = useState(DEFAULT_PLAYLIST_ID);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [infoTarget, setInfoTarget] = useState<ContextPayload | null>(null);

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
      setVolume(state.volume ?? 0.8);
      setShuffle(state.shuffle ?? false);
      setRepeat(state.repeat ?? "off");
      setPlaylists(normalizePlaylists(state.playlists));
      setSelectedPlaylistId(state.selectedPlaylistId ?? DEFAULT_PLAYLIST_ID);
      setNeedsMetadataRefresh(state.librarySchemaVersion !== LIBRARY_SCHEMA_VERSION);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    } finally {
      setRestored(true);
    }
  }, []);

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
        librarySchemaVersion: LIBRARY_SCHEMA_VERSION,
        folders,
        tracks,
        activeTrackId,
        queue,
        playHistory,
        volume,
        shuffle,
        repeat,
        playlists,
        selectedPlaylistId,
      }),
    );
  }, [restored, folders, tracks, activeTrackId, queue, playHistory, volume, shuffle, repeat, playlists, selectedPlaylistId]);

  useEffect(() => {
    if (!activeTrackId) return;
    setPlayHistory((current) => [activeTrackId, ...current.filter((id) => id !== activeTrackId)].slice(0, 24));
  }, [activeTrackId]);

  const activeTrack = useMemo(
    () => tracks.find((track) => track.id === activeTrackId) ?? null,
    [tracks, activeTrackId],
  );

  const favoriteTrackIds = useMemo(
    () => new Set(playlists.find((playlist) => playlist.id === DEFAULT_PLAYLIST_ID)?.trackIds ?? []),
    [playlists],
  );

  const isActiveTrackFavorite = activeTrack ? favoriteTrackIds.has(activeTrack.id) : false;

  const filteredTracks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tracks;
    return tracks.filter((track) =>
      [track.title, track.artist, track.album, track.file_name].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    );
  }, [query, tracks]);

  const albums = useMemo(() => {
    const map = new Map<string, Track[]>();
    for (const track of filteredTracks) {
      const key = albumKey(track.album);
      map.set(key, [...(map.get(key) ?? []), track]);
    }
    return Array.from(map.entries())
      .map(([key, albumTracks]) => {
        const sortedTracks = [...albumTracks].sort(compareTracksForAlbum);
        return {
          key,
          artist: bestAlbumArtist(sortedTracks),
          album: sortedTracks[0]?.album ?? "Unknown album",
          tracks: sortedTracks,
          coverPath: sortedTracks.find((track) => track.cover_path)?.cover_path,
        };
      })
      .sort((a, b) => a.album.localeCompare(b.album));
  }, [filteredTracks]);

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
    for (const track of filteredTracks) map.set(track.artist, [...(map.get(track.artist) ?? []), track]);
    return Array.from(map.entries())
      .map(([artist, artistTracks]) => ({ artist, tracks: artistTracks }))
      .sort((a, b) => a.artist.localeCompare(b.artist));
  }, [filteredTracks]);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (!isPlaying) {
      if (visualizerFrameRef.current) cancelAnimationFrame(visualizerFrameRef.current);
      setBeatFrame(createIdleBeatFrame());
      return;
    }

    startVisualizer();
    return () => {
      if (visualizerFrameRef.current) cancelAnimationFrame(visualizerFrameRef.current);
    };
  }, [isPlaying, activeTrackId]);

  useEffect(() => {
    if (!audioRef.current || !activeTrack) return;

    const sourceUrl = convertFileSrc(activeTrack.path, "zone-audio");
    visualizerUnavailableRef.current = false;
    realtimeBeatRef.current = null;
    offlineBeatGridRef.current = beatGridCacheRef.current.get(activeTrack.id) ?? null;
    setBeatFrame(createIdleBeatFrame());
    audioRef.current.crossOrigin = "anonymous";
    audioRef.current.src = sourceUrl;
    audioRef.current.load();
    void preAnalyzeBeatGrid(activeTrack);

    void audioRef.current
      .play()
      .then(() => {
        setIsPlaying(true);
        void resumeAudioGraph();
      })
      .catch(() => setIsPlaying(false));
  }, [activeTrack]);

  async function addFolder() {
    const folder = await invoke<MusicFolder | null>("select_music_folder");
    if (!folder || folders.some((item) => item.path === folder.path)) return;

    const nextFolders = [...folders, folder];
    setFolders(nextFolders);
    await rescan(nextFolders);
  }

  async function rescan(targetFolders = folders) {
    if (targetFolders.length === 0) return;
    setIsScanning(true);
    setScanNote("scanning");

    try {
      const result = await invoke<ScanResult>("scan_library", {
        folders: targetFolders.map((folder) => folder.path),
      });
      setTracks(result.tracks);
      setQueue(result.tracks.map((track) => track.id));
      setScanNote(`${result.tracks.length} songs indexed`);
      setNeedsMetadataRefresh(false);
      if (!activeTrackId && result.tracks.length > 0) setActiveTrackId(result.tracks[0].id);
    } finally {
      setIsScanning(false);
    }
  }

  function playTrack(track: Track, sourceTracks = filteredTracks) {
    setQueue(sourceTracks.map((item) => item.id));
    setActiveTrackId(track.id);
  }

  function playTracks(targetTracks: Track[]) {
    if (targetTracks.length === 0) return;
    setQueue(targetTracks.map((track) => track.id));
    setActiveTrackId(targetTracks[0].id);
  }

  function appendToQueue(targetTracks: Track[]) {
    setQueue((current) => uniqueIds([...current, ...targetTracks.map((track) => track.id)]));
  }

  function addToPlaylist(playlistId: string, targetTracks: Track[]) {
    const ids = targetTracks.map((track) => track.id);
    if (ids.length === 0) return;

    setPlaylists((items) =>
      normalizePlaylists(items).map((playlist) =>
        playlist.id === playlistId
          ? { ...playlist, trackIds: uniqueIds([...playlist.trackIds, ...ids]) }
          : playlist,
      ),
    );
  }

  function removeFromPlaylist(playlistId: string, targetTracks: Track[]) {
    const ids = new Set(targetTracks.map((track) => track.id));
    if (ids.size === 0) return;

    setPlaylists((items) =>
      normalizePlaylists(items).map((playlist) =>
        playlist.id === playlistId
          ? { ...playlist, trackIds: playlist.trackIds.filter((id) => !ids.has(id)) }
          : playlist,
      ),
    );
  }

  function toggleFavorite() {
    if (!activeTrack) return;
    toggleFavoriteTrack(activeTrack);
  }

  function toggleFavoriteTrack(track: Track) {
    if (favoriteTrackIds.has(track.id)) {
      removeFromPlaylist(DEFAULT_PLAYLIST_ID, [track]);
    } else {
      addToPlaylist(DEFAULT_PLAYLIST_ID, [track]);
    }
  }

  function navigatePage(nextPage: "quickplay" | "collection" | "settings") {
    if (nextPage === "quickplay") setQuery("");
    setPage(nextPage);
  }

  function navigateCollection(nextView: ViewMode) {
    setView(nextView);
    setPage("collection");
  }

  function openNowPlaying() {
    if (!activeTrack) return;
    if (page !== "nowPlaying") previousPageRef.current = page;
    setPage("nowPlaying");
  }

  function createPlaylist(name: string) {
    const cleanName = name.trim();
    if (!cleanName) return;

    const playlist: Playlist = {
      id: `playlist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: cleanName,
      description: "custom playlist",
      trackIds: [],
    };

    setPlaylists((items) => [...normalizePlaylists(items), playlist]);
    setSelectedPlaylistId(playlist.id);
    setView("playlists");
  }

  function saveQueueAsPlaylist(name: string) {
    const cleanName = name.trim();
    const trackIds = uniqueIds(queue);
    if (!cleanName || trackIds.length === 0) return;

    const playlist: Playlist = {
      id: `playlist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: cleanName,
      description: `${trackIds.length} songs`,
      trackIds,
    };

    setPlaylists((items) => [...normalizePlaylists(items), playlist]);
  }

  function showContextMenu(event: React.MouseEvent, payload: ContextPayload) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, payload });
  }

  function closeContextMenu() {
    setContextMenu(null);
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio || !activeTrack) return;

    if (audio.paused) {
      void audio.play().then(() => {
        setIsPlaying(true);
        void resumeAudioGraph();
      });
    } else {
      audio.pause();
      setIsPlaying(false);
    }
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
        const beat = realtimeBeatRef.current.update(
          frequencyData,
          timeData,
          audioRef.current?.currentTime ?? progress,
          audioContextRef.current?.sampleRate,
          analyser.fftSize,
          offlineBeatGridRef.current,
        );
        setBeatFrame(beat);
      }

      setVisualizerEnergy((current) =>
        frame.energy > current ? current * 0.64 + frame.energy * 0.36 : current * 0.9 + frame.energy * 0.1,
      );
      setVisualizerSamples((current) =>
        current.map((previous, index) => {
          const next = frame.samples[index] ?? 0.035;
          return next > previous
            ? previous * 0.58 + next * 0.42
            : previous * 0.9 + next * 0.1;
        }),
      );
      visualizerFrameRef.current = requestAnimationFrame(sample);
    };

    sample();
  }

  function move(delta: 1 | -1) {
    if (tracks.length === 0) return;
    const baseQueue = queue.length > 0 ? queue : tracks.map((track) => track.id);
    const currentIndex = Math.max(0, baseQueue.indexOf(activeTrackId ?? ""));
    const nextIndex = shuffle
      ? Math.floor(Math.random() * baseQueue.length)
      : (currentIndex + delta + baseQueue.length) % baseQueue.length;
    setActiveTrackId(baseQueue[nextIndex]);
  }

  function onEnded() {
    if (repeat === "one" && audioRef.current) {
      audioRef.current.currentTime = 0;
      void audioRef.current.play();
      return;
    }

    const currentIndex = queue.indexOf(activeTrackId ?? "");
    if (repeat === "off" && currentIndex === queue.length - 1) {
      setIsPlaying(false);
      return;
    }

    move(1);
  }

  function seek(value: number) {
    if (!audioRef.current) return;
    audioRef.current.currentTime = value;
    setProgress(value);
  }

  return (
    <div
      className={`shell ${page === "nowPlaying" ? "shell-now-playing" : ""}`}
      onClick={closeContextMenu}
      onContextMenu={(event) => {
        event.preventDefault();
        closeContextMenu();
      }}
    >
      <audio
        ref={audioRef}
        crossOrigin="anonymous"
        onTimeUpdate={(event) => setProgress(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={onEnded}
      />
      <Titlebar />

      <main className="workspace">
        {page !== "nowPlaying" ? (
          <AppHeader
            page={page}
            query={query}
            onQuery={setQuery}
            onNavigate={navigatePage}
            onAddFolder={addFolder}
          />
        ) : null}

        {page === "quickplay" ? (
          <QuickplayView
            tracks={tracks}
            albums={albums}
            activeTrack={activeTrack}
            historyIds={playHistory}
            onPlay={playTrack}
            onPlayTracks={playTracks}
            onOpenNowPlaying={openNowPlaying}
            onOpenCollection={() => navigateCollection("albums")}
            onContextMenu={showContextMenu}
          />
        ) : null}

        {page === "collection" && (
          <section className="content-band">
            <div className="collection-header">
              <div className="collection-title">
                <h1>collection</h1>
                <p>
                  {tracks.length === 0
                    ? "选择一个文件夹开始"
                    : view === "albums"
                      ? `${albums.length} 张专辑`
                      : view === "artists"
                        ? `${artists.length} 位艺术家`
                        : view === "playlists"
                          ? `${playlists.length} 个播放列表`
                          : `${filteredTracks.length} 首歌曲`}
                  {scanNote ? ` · ${scanNote}` : ""}
                </p>
              </div>
              <div className="collection-navigation">
                <span>音乐</span>
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
              </div>
            </div>

            {tracks.length === 0 ? (
              <EmptyState onAddFolder={addFolder} isScanning={isScanning} />
            ) : (
              <LibraryView
                key={view}
                view={view}
                tracks={filteredTracks}
                albums={albums}
                artists={artists}
                queueIds={queue}
                activeTrackId={activeTrackId}
                selectedAlbumKey={selectedAlbumKey}
                onSelectAlbum={setSelectedAlbumKey}
                onPlay={playTrack}
                onPlayTracks={playTracks}
                onContextMenu={showContextMenu}
                playlists={playlists}
                selectedPlaylistId={selectedPlaylistId}
                onSelectPlaylist={setSelectedPlaylistId}
                onCreatePlaylist={createPlaylist}
                favoriteTrackIds={favoriteTrackIds}
                onToggleFavorite={toggleFavoriteTrack}
              />
            )}
          </section>
        )}

        {page === "nowPlaying" && (
          <NowPlayingView
            track={activeTrack}
            tracks={tracks}
            queue={queue.map((id) => tracks.find((track) => track.id === id)).filter(Boolean) as Track[]}
            isPlaying={isPlaying}
            progress={progress}
            duration={duration}
            shuffle={shuffle}
            repeat={repeat}
            visualizerSamples={visualizerSamples}
            visualizerEnergy={visualizerEnergy}
            beatPulse={beatFrame.beatPulse}
            beatPhase={beatFrame.beatPhase}
            onsetStrength={beatFrame.onsetStrength}
            beatConfidence={beatFrame.confidence}
            isFavorite={isActiveTrackFavorite}
            volume={volume}
            onBack={() => setPage(previousPageRef.current)}
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
              setActiveTrackId(null);
              setScanNote("");
              localStorage.removeItem(STORAGE_KEY);
            }}
          />
        )}
      </main>

      {page !== "nowPlaying" && (
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
      )}

      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          playlists={playlists}
          onClose={closeContextMenu}
          onPlay={() => playTracks(contextMenu.payload.tracks)}
          onAddToQueue={() => appendToQueue(contextMenu.payload.tracks)}
          onAddToPlaylist={(playlistId) => addToPlaylist(playlistId, contextMenu.payload.tracks)}
          onInfo={() => setInfoTarget(contextMenu.payload)}
        />
      )}

      {infoTarget && <InfoPanel payload={infoTarget} onClose={() => setInfoTarget(null)} />}
    </div>
  );
}
