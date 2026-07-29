import type { CSSProperties } from "react";
import type { LyricsLine, LyricsWord } from "../../types";
import type { LyricsOnlineSearchState } from "../../hooks/useLyrics";
import type { LyricsDisplaySettings, LyricsFontSize } from "../../utils/lyricsDisplay";

export const BROWSE_RETURN_DELAY = 3_000;
export const WHEEL_STEP_THRESHOLD = 34;

export type LyricsLineStyle = CSSProperties & {
  "--lyrics-y": string;
  "--lyrics-distance": number;
  "--lyrics-opacity": number;
  "--lyrics-scale": number;
  "--lyrics-blur": string;
};

export function findActiveLine(lines: LyricsLine[], progress: number) {
  if (lines.length === 0) return -1;
  let activeIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (progress < lines[index].start) break;
    activeIndex = index;
  }
  return activeIndex;
}

export function getWordProgress(word: LyricsWord, progress: number) {
  if (progress <= word.start) return 0;
  if (progress >= word.end) return 1;
  return (progress - word.start) / Math.max(0.001, word.end - word.start);
}

export function getBackgroundPresence(start: number, end: number, progress: number) {
  if (progress < start || progress >= end) return 0;
  const fadeIn = Math.min(1, (progress - start) / 0.16);
  const fadeOut = Math.min(1, (end - progress) / 0.22);
  return Math.max(0, Math.min(fadeIn, fadeOut));
}

export function lineAriaLabel(line: LyricsLine, isPlain: boolean, settings: LyricsDisplaySettings) {
  if (isPlain) return line.text;
  const supportingText = [
    settings.showTranslation ? line.translation : undefined,
    settings.showTransliteration ? line.transliteration : undefined,
    ...(!settings.showBackgroundVocals ? [] : (line.background ?? []).flatMap((background) => [
      `背景人声：${background.text}`,
      settings.showTranslation ? background.translation : undefined,
      settings.showTransliteration ? background.transliteration : undefined,
    ])),
  ].filter(Boolean);
  return [`跳转到歌词：${line.text}`, ...supportingText].join("；");
}

export function lineStyle(offset: number, browsing: boolean): LyricsLineStyle {
  const distance = Math.abs(offset);
  const opacity = browsing
    ? Math.max(0.2, 1 - distance * 0.18)
    : distance === 0
      ? 1
      : Math.max(0.06, 0.48 - (distance - 1) * 0.14);
  const scale = Math.max(0.74, 1 - distance * 0.085);
  const blur = browsing || distance === 0 ? 0 : Math.min(6, 1.4 + (distance - 1) * 1.65);

  return {
    "--lyrics-y": `${offset * 10.5}vh`,
    "--lyrics-distance": distance,
    "--lyrics-opacity": opacity,
    "--lyrics-scale": scale,
    "--lyrics-blur": `${blur}px`,
  };
}

export function formatDuration(value: number) {
  const seconds = Math.max(0, Math.round(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function providerOutcomeLabel(status: LyricsOnlineSearchState["providers"][number]["status"]) {
  if (status === "ready") return "有结果";
  if (status === "empty") return "未找到";
  return "失败";
}

export function fontSizeLabel(fontSize: LyricsFontSize) {
  if (fontSize === "small") return "小";
  if (fontSize === "large") return "大";
  return "标准";
}

export function fileName(path: string) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
