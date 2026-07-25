import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { FolderPlus, Search } from "lucide-react";
import { Titlebar } from "./components/Titlebar";
import { EmptyState } from "./components/EmptyState";
import { PlayerBar } from "./components/PlayerBar";
import { ContextMenu } from "./components/ContextMenu";
import { InfoPanel } from "./components/InfoPanel";
import { LibraryView } from "./views/LibraryView";
import { NowPlayingView } from "./views/NowPlayingView";
import { SettingsView } from "./views/SettingsView";
import { DEFAULT_PLAYLIST_ID, LIBRARY_SCHEMA_VERSION, STORAGE_KEY, VISUALIZER_SAMPLE_COUNT } from "./constants";
import { albumKey, bestAlbumArtist, compareTracksForAlbum, defaultPlaylists, normalizePlaylists, uniqueIds } from "./utils/music";
import { createAudioVisualizerFrame, createIdleVisualizerFrame } from "./utils/visualizer";
import type { AlbumGroup, AppPage, ArtistGroup, ContextMenuState, ContextPayload, MusicFolder, Playlist, RepeatMode, ScanResult, Track, ViewMode } from "./types";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export default function App() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const outputGainRef = useRef<GainNode | null>(null);
  const visualizerFrameRef = useRef<number | null>(null);
  const visualizerSilenceFramesRef = useRef(0);
  const visualizerUnavailableRef = useRef(false);
  const [folders, setFolders] = useState<MusicFolder[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>("albums");
  const [page, setPage] = useState<AppPage>("collection");
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
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
        volume,
        shuffle,
        repeat,
        playlists,
        selectedPlaylistId,
      }),
    );
  }, [restored, folders, tracks, activeTrackId, queue, volume, shuffle, repeat, playlists, selectedPlaylistId]);

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
    audioRef.current.crossOrigin = "anonymous";
    audioRef.current.src = sourceUrl;
    audioRef.current.load();

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
    if (favoriteTrackIds.has(activeTrack.id)) {
      removeFromPlaylist(DEFAULT_PLAYLIST_ID, [activeTrack]);
    } else {
      addToPlaylist(DEFAULT_PLAYLIST_ID, [activeTrack]);
    }
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
        {page !== "nowPlaying" && (
          <section className="masthead">
            <div>
              <p className="brand">zone</p>
              <div className="pivot">
                <button className={page === "collection" ? "pivot-active" : ""} onClick={() => setPage("collection")}>
                  collection
                </button>
                <button onClick={() => setPage("nowPlaying")}>
                  now playing
                </button>
                <button className={page === "settings" ? "pivot-active" : ""} onClick={() => setPage("settings")}>
                  settings
                </button>
              </div>
            </div>

            <div className={`library-actions ${page !== "collection" ? "library-actions-muted" : ""}`}>
              <label className="search-box">
                <Search size={18} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="search music"
                  disabled={page !== "collection"}
                />
              </label>
              <button className="icon-text" onClick={addFolder} title="Add music folder">
                <FolderPlus size={19} />
                <span>folder</span>
              </button>
            </div>
          </section>
        )}

        {page === "collection" && (
          <section className="content-band">
            <div className="collection-header">
              <div>
                <h1>music</h1>
                <p>
                  {tracks.length === 0
                    ? "choose a folder to start"
                    : `${filteredTracks.length} of ${tracks.length} songs`}
                  {scanNote ? ` · ${scanNote}` : ""}
                </p>
              </div>
              <div className="segmented">
                {(["albums", "artists", "songs", "playlists"] as ViewMode[]).map((item) => (
                  <button
                    key={item}
                    className={view === item ? "selected" : ""}
                    onClick={() => setView(item)}
                  >
                    {item}
                  </button>
                ))}
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
            isFavorite={isActiveTrackFavorite}
            onBack={() => setPage("collection")}
            onPlay={playTrack}
            onPlayPause={togglePlay}
            onToggleFavorite={toggleFavorite}
            onPrevious={() => move(-1)}
            onNext={() => move(1)}
            onSeek={seek}
            onShuffle={() => setShuffle((value) => !value)}
            onRepeat={() => setRepeat((value) => (value === "off" ? "all" : value === "all" ? "one" : "off"))}
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
          onPlayPause={togglePlay}
          onPrevious={() => move(-1)}
          onNext={() => move(1)}
          onSeek={seek}
          onVolume={setVolume}
          onShuffle={() => setShuffle((value) => !value)}
          onRepeat={() => setRepeat((value) => (value === "off" ? "all" : value === "all" ? "one" : "off"))}
          onOpenNowPlaying={() => setPage("nowPlaying")}
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
