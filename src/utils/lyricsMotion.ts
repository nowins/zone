import type { LyricsWord } from "../types.js";
import { smoothstep } from "../motion/math.js";

export const LYRICS_LONG_NOTE_MIN_DURATION = 0.95;
const LYRICS_LONG_NOTE_FULL_DURATION = 1.8;

export function isLyricsLongNote(word: LyricsWord) {
  return word.end - word.start >= LYRICS_LONG_NOTE_MIN_DURATION;
}

export function lyricsLongNoteEnvelope(word: LyricsWord, progress: number) {
  const duration = word.end - word.start;
  if (duration < LYRICS_LONG_NOTE_MIN_DURATION || progress <= word.start || progress >= word.end) return 0;

  const durationWeight = smoothstep(
    LYRICS_LONG_NOTE_MIN_DURATION,
    LYRICS_LONG_NOTE_FULL_DURATION,
    duration,
  );
  const wordProgress = (progress - word.start) / Math.max(0.001, duration);
  const attack = smoothstep(0.34, 0.68, wordProgress);
  const release = 1 - smoothstep(0.86, 1, wordProgress);
  return Math.max(0, Math.min(1, durationWeight * attack * release));
}
