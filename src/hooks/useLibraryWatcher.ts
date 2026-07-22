import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { MusicFolder } from "../types";

const LIBRARY_REFRESH_DEBOUNCE_MS = 800;

type LibraryFilesChanged = {
  paths: string[];
};

export function useLibraryWatcher(
  folders: MusicFolder[],
  enabled: boolean,
  onLibraryChanged: (paths: string[]) => void,
) {
  const onLibraryChangedRef = useRef(onLibraryChanged);
  const folderKey = enabled ? folders.map((folder) => folder.path).join("\u0000") : "";
  onLibraryChangedRef.current = onLibraryChanged;

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    let refreshTimer: number | null = null;
    const watchedFolders = folderKey ? folderKey.split("\u0000") : [];

    void (async () => {
      try {
        unlisten = await listen<LibraryFilesChanged>("library-files-changed", ({ payload }) => {
          if (cancelled) return;
          if (refreshTimer !== null) window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => {
            refreshTimer = null;
            if (import.meta.env.DEV) console.info("[library] refreshing after filesystem change", payload.paths);
            onLibraryChangedRef.current(payload.paths);
          }, LIBRARY_REFRESH_DEBOUNCE_MS);
        });
      } catch (error) {
        if (import.meta.env.DEV) console.warn("[library] unable to subscribe to folder changes", error);
      }
      if (cancelled) {
        unlisten?.();
        return;
      }

      await invoke("watch_music_folders", { folders: watchedFolders }).catch((error) => {
        if (import.meta.env.DEV) console.warn("[library] folder watcher unavailable", error);
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [folderKey]);
}
