import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookSource = readFileSync("src/hooks/useLibraryWatcher.ts", "utf8");
const appSource = [
  "src/app/podcastPlaybackSettings.ts",
  "src/hooks/useNavigation.ts",
  "src/hooks/useMusicLibrary.ts",
  "src/hooks/usePodcastPlayback.ts",
  "src/hooks/usePlaybackControls.ts",
  "src/hooks/useAudioEngine.ts",
  "src/hooks/usePlaylists.ts",
  "src/App.tsx",
].map((path) => readFileSync(path, "utf8")).join("\n");
const rustSource = readFileSync("src-tauri/src/library.rs", "utf8");

test("library watcher is recursive, filtered, and frontend-debounced", () => {
  assert.ok(rustSource.includes("watcher.watch(&path, RecursiveMode::Recursive)"));
  assert.ok(rustSource.includes("should_refresh_library(&event)"));
  assert.ok(hookSource.includes('listen<LibraryFilesChanged>("library-files-changed"'));
  assert.ok(hookSource.includes("const LIBRARY_REFRESH_DEBOUNCE_MS = 800"));
  assert.ok(hookSource.includes('invoke("watch_music_folders"'));
});

test("automatic scans serialize bursts and ignore results for stale folder sets", () => {
  assert.ok(appSource.includes("scanInFlightRef.current"));
  assert.ok(appSource.includes("queuedScanRef.current"));
  assert.ok(appSource.includes("requestedFolders === currentFolders"));
  assert.ok(appSource.includes('setScanNote(automatic ? "检测到文件变化，正在同步" : "正在扫描")'));
});

test("automatic scans do not reload an unchanged active audio file", () => {
  assert.ok(appSource.includes("playbackSourceKey(activePlayback.track)"));
  assert.ok(appSource.includes("}, [activePlaybackSourceKey]);"));
  assert.ok(!appSource.includes("}, [activePlayback]);"));
  assert.ok(!appSource.includes("}, [activeTrack]);"));
});
