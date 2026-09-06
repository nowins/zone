import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { musicScanLibrary } from "../app/musicLibraryApi";
import { useLibraryWatcher } from "./useLibraryWatcher";
import { albumKey, bestAlbumArtist, compareTracksForAlbum } from "../utils/music";
import { reconcileQueueWithLibrary } from "../utils/playback";
import { createTrackActivity } from "../utils/smartPlaylist";
import type {
  ArtistGroup,
  MusicFolder,
  Track,
  TrackActivityMap,
  ViewMode,
} from "../types";

type UseMusicLibraryParams = {
  view: ViewMode;
  selectedAlbumKey: string | null;
  setSelectedAlbumKey: React.Dispatch<React.SetStateAction<string | null>>;
  setQueue: React.Dispatch<React.SetStateAction<string[]>>;
};

export function useMusicLibrary({
  view,
  selectedAlbumKey,
  setSelectedAlbumKey,
  setQueue,
}: UseMusicLibraryParams) {
  const activityMigrationRef = useRef(false);
  const scanInFlightRef = useRef(false);
  const queuedScanRef = useRef<{ folders: MusicFolder[]; automatic: boolean } | null>(null);
  const [folders, setFolders] = useState<MusicFolder[]>([]);
  const foldersRef = useRef<MusicFolder[]>(folders);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanNote, setScanNote] = useState("");
  const [restored, setRestored] = useState(false);
  const [needsMetadataRefresh, setNeedsMetadataRefresh] = useState(false);
  const [trackActivity, setTrackActivity] = useState<TrackActivityMap>({});
  foldersRef.current = folders;

  useLibraryWatcher(folders, restored, () => {
    void rescan(folders, true);
  });

  useEffect(() => {
    if (!restored || folders.length === 0 || tracks.length === 0) return;
    if (!needsMetadataRefresh && "cover_path" in tracks[0]) return;

    void rescan(folders);
  }, [restored, needsMetadataRefresh]);

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
        const result = await musicScanLibrary(pending.folders, count => setScanNote(`已读取 ${count} 首歌曲`));
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
      setScanNote(String(error).includes("已取消") ? "扫描已取消" : "曲库同步失败");
      if (import.meta.env.DEV) console.warn("[library] scan failed", error);
    } finally {
      scanInFlightRef.current = false;
      setIsScanning(false);
    }
  }

  function cancelScan() {
    queuedScanRef.current = null;
    void invoke("music_cancel_scan").catch(() => setScanNote("取消失败，请重试"));
  }

  return {
    cancelScan,
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
  };
}
