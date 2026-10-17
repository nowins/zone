import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { musicScanLibrary } from "../app/musicLibraryApi";
import { useLibraryWatcher } from "./useLibraryWatcher";
import { buildCollectionIndex } from "../utils/collectionEntities";
import { reconcileQueueWithLibrary } from "../utils/playback";
import { createTrackActivity } from "../utils/smartPlaylist";
import type {
  MusicFolder,
  Track,
  TrackActivityMap,
} from "../types";

type UseMusicLibraryParams = {
  persistenceReady?: boolean;
  setQueue: React.Dispatch<React.SetStateAction<string[]>>;
};

export function useMusicLibrary({
  setQueue,
  persistenceReady = true,
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

  useLibraryWatcher(folders, restored && persistenceReady, () => {
    void rescan(folders, true);
  });

  useEffect(() => {
    if (!restored || !persistenceReady || folders.length === 0 || tracks.length === 0) return;
    if (!needsMetadataRefresh && "cover_path" in tracks[0]) return;

    void rescan(folders);
  }, [restored, persistenceReady, needsMetadataRefresh]);

  useEffect(() => {
    if (!restored) return;
    if (activityMigrationRef.current && needsMetadataRefresh) return;
    const now = Date.now();
    const isMigrating = activityMigrationRef.current;
    setTrackActivity((current) => {
      const next: TrackActivityMap = { ...current };
      for (const track of tracks) {
        const migrationBaseline = isMigrating ? track.added_at ?? now : now;
        next[track.id] = createTrackActivity(current[track.id], migrationBaseline);
      }
      return next;
    });
    activityMigrationRef.current = false;
  }, [needsMetadataRefresh, restored, tracks]);

  const collectionIndex = useMemo(() => buildCollectionIndex(tracks), [tracks]);
  const { albums, artists } = collectionIndex;

  async function addFolder() {
    if (!persistenceReady) { setScanNote("资料库尚未恢复，添加目录已暂停"); return; }
    const folder = await invoke<MusicFolder | null>("select_music_folder");
    if (!folder || folders.some((item) => item.path === folder.path)) return;

    const nextFolders = [...folders, folder];
    setFolders(nextFolders);
    await rescan(nextFolders);
  }

  async function rescan(targetFolders = folders, automatic = false) {
    if (!persistenceReady) { setScanNote("资料库尚未恢复，扫描已暂停"); return; }
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
      const message = String(error);
      setScanNote(message.includes("已取消") ? "扫描已取消"
        : message.includes("已保留原资料库") ? "音乐来源暂不可用，已保留资料库，请稍后重试" : "曲库同步失败");
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
    collectionIndex,
    albums,
    artists,
    addFolder,
    rescan,
  };
}
