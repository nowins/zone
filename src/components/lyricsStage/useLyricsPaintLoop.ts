import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LyricsDocument, LyricsLine } from "../../types";
import { lyricsLongNoteEnvelope } from "../../utils/lyricsMotion";
import { mediaTimeToLyricsTime } from "../../utils/lyricsTiming";
import { findActiveLine, getBackgroundPresence, getWordProgress } from "./lyricsLineUtils";

/**
 * Owns the per-frame word painting for the lyrics stage: the DOM refs the
 * line renderer writes into, the active-line index, and the rAF loop that
 * reads the real media clock and paints clip-paths directly (no React state
 * per frame).
 */
export function useLyricsPaintLoop({
  document,
  isPlain,
  lines,
  lyricsProgress,
  timingOffsetMs,
  playbackClock,
  isPlaying,
  visible,
}: {
  document: LyricsDocument | null;
  isPlain: boolean;
  lines: LyricsLine[];
  lyricsProgress: number;
  timingOffsetMs: number;
  playbackClock: () => number;
  isPlaying: boolean;
  visible: boolean;
}) {
  const wordProgressRefs = useRef<Array<Array<HTMLSpanElement | null>>>([]);
  const wordMotionRefs = useRef<Array<Array<HTMLSpanElement | null>>>([]);
  const wordSustainRefs = useRef<Array<Array<HTMLSpanElement | null>>>([]);
  const backgroundLineRefs = useRef<Array<Array<HTMLSpanElement | null>>>([]);
  const backgroundWordProgressRefs = useRef<Array<Array<Array<HTMLSpanElement | null>>>>([]);
  const playbackClockRef = useRef(playbackClock);
  const initialActiveIndex = useMemo(
    () => isPlain ? -1 : findActiveLine(lines, lyricsProgress),
    [document?.trackId, document?.sourceId, isPlain],
  );
  const [activeIndex, setActiveIndex] = useState(initialActiveIndex);
  const activeIndexRef = useRef(initialActiveIndex);

  playbackClockRef.current = playbackClock;

  const paintWordProgress = useCallback((time: number, syncEveryLine = false) => {
    if (isPlain) return;
    const nextActiveIndex = findActiveLine(lines, time);
    if (nextActiveIndex !== activeIndexRef.current) {
      activeIndexRef.current = nextActiveIndex;
      setActiveIndex(nextActiveIndex);
      syncEveryLine = true;
    }

    lines.forEach((line, lineIndex) => {
      if (!syncEveryLine && lineIndex !== nextActiveIndex) return;
      const words = line.words ?? [{ text: line.text, start: line.start, end: line.end }];
      words.forEach((word, wordIndex) => {
        const element = wordProgressRefs.current[lineIndex]?.[wordIndex];
        if (!element) return;
        const fill = lineIndex < nextActiveIndex
          ? 1
          : lineIndex > nextActiveIndex
            ? 0
            : getWordProgress(word, time);
        element.style.clipPath = `inset(0 ${(1 - fill) * 100}% 0 0)`;
        const sustain = line.words?.length && lineIndex === nextActiveIndex
          ? lyricsLongNoteEnvelope(word, time)
          : 0;
        const motionElement = wordMotionRefs.current[lineIndex]?.[wordIndex];
        if (motionElement) motionElement.style.transform = `scale(${(1 + sustain * 0.016).toFixed(4)})`;
        const sustainElement = wordSustainRefs.current[lineIndex]?.[wordIndex];
        if (sustainElement) {
          sustainElement.style.clipPath = `inset(0 ${(1 - fill) * 100}% 0 0)`;
          sustainElement.style.opacity = String(sustain * 0.34);
        }
      });

      line.background?.forEach((background, backgroundIndex) => {
        const presence = lineIndex === nextActiveIndex
          ? getBackgroundPresence(background.start, background.end, time)
          : 0;
        const backgroundElement = backgroundLineRefs.current[lineIndex]?.[backgroundIndex];
        backgroundElement?.style.setProperty("--lyrics-background-presence", String(presence));
        backgroundElement?.style.setProperty("--lyrics-background-shift", `${(1 - presence) * 4}px`);

        const backgroundWords = background.words ?? [{
          text: background.text,
          start: background.start,
          end: background.end,
        }];
        backgroundWords.forEach((word, wordIndex) => {
          const element = backgroundWordProgressRefs.current[lineIndex]?.[backgroundIndex]?.[wordIndex];
          if (!element) return;
          const fill = lineIndex < nextActiveIndex
            ? 1
            : lineIndex > nextActiveIndex
              ? 0
              : getWordProgress(word, time);
          element.style.clipPath = `inset(0 ${(1 - fill) * 100}% 0 0)`;
        });
      });
    });
  }, [isPlain, lines]);

  useEffect(() => {
    const nextActiveIndex = isPlain ? -1 : findActiveLine(lines, lyricsProgress);
    activeIndexRef.current = nextActiveIndex;
    setActiveIndex(nextActiveIndex);
    window.requestAnimationFrame(() => {
      paintWordProgress(mediaTimeToLyricsTime(playbackClockRef.current(), timingOffsetMs), true);
    });
  }, [document?.trackId, document?.sourceId, isPlain, visible]);

  useEffect(() => {
    if (!visible) return;
    if (!isPlaying) {
      paintWordProgress(mediaTimeToLyricsTime(playbackClockRef.current(), timingOffsetMs), true);
      return;
    }

    let frame = 0;
    const drawFrame = () => {
      paintWordProgress(mediaTimeToLyricsTime(playbackClockRef.current(), timingOffsetMs));
      frame = window.requestAnimationFrame(drawFrame);
    };
    frame = window.requestAnimationFrame(drawFrame);
    return () => window.cancelAnimationFrame(frame);
  }, [document?.trackId, document?.sourceId, isPlaying, paintWordProgress, timingOffsetMs, visible]);

  useEffect(() => {
    if (visible && !isPlaying) paintWordProgress(lyricsProgress, true);
  }, [isPlaying, lyricsProgress, paintWordProgress, visible]);

  return {
    activeIndex,
    wordProgressRefs,
    wordMotionRefs,
    wordSustainRefs,
    backgroundLineRefs,
    backgroundWordProgressRefs,
  };
}
