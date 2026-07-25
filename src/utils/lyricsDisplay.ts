export const LYRICS_FONT_SIZE_OPTIONS = ["small", "standard", "large"] as const;

export type LyricsFontSize = (typeof LYRICS_FONT_SIZE_OPTIONS)[number];

export type LyricsDisplaySettings = {
  fontSize: LyricsFontSize;
  showTranslation: boolean;
  showTransliteration: boolean;
  showBackgroundVocals: boolean;
};

export const DEFAULT_LYRICS_DISPLAY_SETTINGS: LyricsDisplaySettings = {
  fontSize: "standard",
  showTranslation: true,
  showTransliteration: true,
  showBackgroundVocals: true,
};

export function normalizeLyricsDisplaySettings(value: unknown): LyricsDisplaySettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_LYRICS_DISPLAY_SETTINGS };
  const candidate = value as Partial<LyricsDisplaySettings>;
  return {
    fontSize: LYRICS_FONT_SIZE_OPTIONS.includes(candidate.fontSize as LyricsFontSize)
      ? candidate.fontSize as LyricsFontSize
      : DEFAULT_LYRICS_DISPLAY_SETTINGS.fontSize,
    showTranslation: typeof candidate.showTranslation === "boolean"
      ? candidate.showTranslation
      : DEFAULT_LYRICS_DISPLAY_SETTINGS.showTranslation,
    showTransliteration: typeof candidate.showTransliteration === "boolean"
      ? candidate.showTransliteration
      : DEFAULT_LYRICS_DISPLAY_SETTINGS.showTransliteration,
    showBackgroundVocals: typeof candidate.showBackgroundVocals === "boolean"
      ? candidate.showBackgroundVocals
      : DEFAULT_LYRICS_DISPLAY_SETTINGS.showBackgroundVocals,
  };
}
