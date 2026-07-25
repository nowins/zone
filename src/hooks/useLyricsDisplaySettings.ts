import { useCallback, useState } from "react";
import {
  DEFAULT_LYRICS_DISPLAY_SETTINGS,
  normalizeLyricsDisplaySettings,
  type LyricsDisplaySettings,
  type LyricsFontSize,
} from "../utils/lyricsDisplay";

const LYRICS_DISPLAY_STORAGE_KEY = "zone-lyrics-display-v1";

export function useLyricsDisplaySettings() {
  const [settings, setSettings] = useState<LyricsDisplaySettings>(readLyricsDisplaySettings);

  const update = useCallback((recipe: (current: LyricsDisplaySettings) => LyricsDisplaySettings) => {
    setSettings((current) => {
      const next = normalizeLyricsDisplaySettings(recipe(current));
      try {
        localStorage.setItem(LYRICS_DISPLAY_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Display preferences remain valid for this session when storage is unavailable.
      }
      return next;
    });
  }, []);

  const setFontSize = useCallback((fontSize: LyricsFontSize) => {
    update((current) => ({ ...current, fontSize }));
  }, [update]);

  const setDisplayOption = useCallback((
    option: "showTranslation" | "showTransliteration" | "showBackgroundVocals",
    enabled: boolean,
  ) => {
    update((current) => ({ ...current, [option]: enabled }));
  }, [update]);

  return {
    settings,
    setFontSize,
    setDisplayOption,
  };
}

function readLyricsDisplaySettings(): LyricsDisplaySettings {
  try {
    const raw = localStorage.getItem(LYRICS_DISPLAY_STORAGE_KEY);
    return raw
      ? normalizeLyricsDisplaySettings(JSON.parse(raw))
      : { ...DEFAULT_LYRICS_DISPLAY_SETTINGS };
  } catch {
    return { ...DEFAULT_LYRICS_DISPLAY_SETTINGS };
  }
}
