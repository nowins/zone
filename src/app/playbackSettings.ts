export type QueueInsertMode = "play_next" | "append_end";

export type PlaybackBehaviorSettings = {
  queueInsertMode: QueueInsertMode;
  adaptivePrevious: boolean;
  closeToTray: boolean;
};

const STORAGE_KEY = "zone-playback-behavior-v1";

export const DEFAULT_PLAYBACK_BEHAVIOR: PlaybackBehaviorSettings = {
  queueInsertMode: "append_end",
  adaptivePrevious: true,
  closeToTray: true,
};

export function readPlaybackBehaviorSettings(): PlaybackBehaviorSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PLAYBACK_BEHAVIOR };
    const parsed = JSON.parse(raw) as Partial<PlaybackBehaviorSettings>;
    return {
      queueInsertMode: parsed.queueInsertMode === "play_next" ? "play_next" : "append_end",
      adaptivePrevious: parsed.adaptivePrevious !== false,
      closeToTray: parsed.closeToTray !== false,
    };
  } catch {
    return { ...DEFAULT_PLAYBACK_BEHAVIOR };
  }
}

export function writePlaybackBehaviorSettings(next: PlaybackBehaviorSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function patchPlaybackBehaviorSettings(
  patch: Partial<PlaybackBehaviorSettings>,
): PlaybackBehaviorSettings {
  const next = {
    ...readPlaybackBehaviorSettings(),
    ...patch,
  };
  writePlaybackBehaviorSettings(next);
  return next;
}
