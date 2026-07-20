import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type WheelEvent } from "react";
import type { LyricsDocument, LyricsLine, LyricsWord } from "../types";

const BROWSE_RETURN_DELAY = 3_000;
const WHEEL_STEP_THRESHOLD = 34;

type LyricsLineStyle = CSSProperties & {
  "--lyrics-y": string;
  "--lyrics-distance": number;
  "--lyrics-opacity": number;
  "--lyrics-scale": number;
  "--lyrics-blur": string;
};

function findActiveLine(lines: LyricsLine[], progress: number) {
  if (lines.length === 0) return -1;
  let activeIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (progress < lines[index].start) break;
    activeIndex = index;
  }
  return activeIndex;
}

function getWordProgress(word: LyricsWord, progress: number) {
  if (progress <= word.start) return 0;
  if (progress >= word.end) return 1;
  return (progress - word.start) / Math.max(0.001, word.end - word.start);
}

function lineStyle(offset: number, browsing: boolean): LyricsLineStyle {
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

export function LyricsStage({
  document,
  progress,
  isPlaying,
  playbackClock,
  visible,
  onSeek,
  onInteraction,
}: {
  document: LyricsDocument | null;
  progress: number;
  isPlaying: boolean;
  playbackClock: () => number;
  visible: boolean;
  onSeek: (value: number) => void;
  onInteraction: () => void;
}) {
  const [browseIndex, setBrowseIndex] = useState<number | null>(null);
  const [navigationInput, setNavigationInput] = useState<"pointer" | "keyboard">("pointer");
  const returnTimerRef = useRef<number | null>(null);
  const wheelDeltaRef = useRef(0);
  const lineButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const wordProgressRefs = useRef<Array<Array<HTMLSpanElement | null>>>([]);
  const playbackClockRef = useRef(playbackClock);
  const lines = document?.lines ?? [];
  const initialActiveIndex = useMemo(() => findActiveLine(lines, progress), [document?.trackId]);
  const [activeIndex, setActiveIndex] = useState(initialActiveIndex);
  const activeIndexRef = useRef(initialActiveIndex);
  const focusIndex = browseIndex ?? activeIndex;
  const browsing = browseIndex !== null;

  playbackClockRef.current = playbackClock;

  const paintWordProgress = useCallback((time: number, syncEveryLine = false) => {
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
      });
    });
  }, [lines]);

  function clearReturnTimer() {
    if (returnTimerRef.current) window.clearTimeout(returnTimerRef.current);
    returnTimerRef.current = null;
  }

  function scheduleReturnToPlayback() {
    clearReturnTimer();
    returnTimerRef.current = window.setTimeout(() => {
      setBrowseIndex(null);
      setNavigationInput("pointer");
      wheelDeltaRef.current = 0;
    }, BROWSE_RETURN_DELAY);
  }

  function browseTo(index: number) {
    if (lines.length === 0) return;
    setBrowseIndex(Math.min(lines.length - 1, Math.max(0, index)));
    scheduleReturnToPlayback();
    onInteraction();
  }

  function handleWheel(event: WheelEvent<HTMLElement>) {
    if (!visible || lines.length === 0) return;
    event.preventDefault();
    setNavigationInput("pointer");
    wheelDeltaRef.current += event.deltaY;
    if (Math.abs(wheelDeltaRef.current) < WHEEL_STEP_THRESHOLD) return;
    const direction = wheelDeltaRef.current > 0 ? 1 : -1;
    wheelDeltaRef.current = 0;
    browseTo((browseIndex ?? activeIndex) + direction);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    setNavigationInput("keyboard");
    const nextIndex = Math.min(
      lines.length - 1,
      Math.max(0, (browseIndex ?? activeIndex) + (event.key === "ArrowDown" ? 1 : -1)),
    );
    browseTo(nextIndex);
    lineButtonRefs.current[nextIndex]?.focus();
  }

  function seekToLine(line: LyricsLine, keyboardInitiated: boolean) {
    clearReturnTimer();
    setBrowseIndex(null);
    wheelDeltaRef.current = 0;
    setNavigationInput(keyboardInitiated ? "keyboard" : "pointer");
    onSeek(line.start);
    onInteraction();
    if (keyboardInitiated) window.requestAnimationFrame(() => setNavigationInput("pointer"));
  }

  useEffect(() => {
    setBrowseIndex(null);
    setNavigationInput("pointer");
    wheelDeltaRef.current = 0;
    clearReturnTimer();
    const nextActiveIndex = findActiveLine(lines, progress);
    activeIndexRef.current = nextActiveIndex;
    setActiveIndex(nextActiveIndex);
    window.requestAnimationFrame(() => paintWordProgress(playbackClockRef.current(), true));
  }, [document?.trackId, visible]);

  useEffect(() => {
    if (!visible) return;
    if (!isPlaying) {
      paintWordProgress(playbackClockRef.current(), true);
      return;
    }

    let frame = 0;
    const drawFrame = () => {
      paintWordProgress(playbackClockRef.current());
      frame = window.requestAnimationFrame(drawFrame);
    };
    frame = window.requestAnimationFrame(drawFrame);
    return () => window.cancelAnimationFrame(frame);
  }, [document?.trackId, isPlaying, paintWordProgress, visible]);

  useEffect(() => {
    if (visible && !isPlaying) paintWordProgress(progress, true);
  }, [isPlaying, paintWordProgress, progress, visible]);

  useEffect(() => () => clearReturnTimer(), []);

  if (!document) {
    return (
      <section className={`lyrics-stage ${visible ? "is-visible" : ""}`} aria-hidden={!visible} aria-label="歌词">
        <p className="lyrics-empty">暂无歌词</p>
      </section>
    );
  }

  return (
    <section
      className={`lyrics-stage ${visible ? "is-visible" : ""} ${browsing ? "is-browsing" : ""} ${
        navigationInput === "keyboard" ? "is-keyboard-browsing" : ""
      }`}
      aria-hidden={!visible}
      aria-label="歌词"
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onPointerDown={() => setNavigationInput("pointer")}
    >
      <div className="lyrics-lines">
        {lines.map((line, index) => {
          const offset = index - focusIndex;
          const distance = Math.abs(offset);
          const isPlaybackLine = index === activeIndex;
          const isFocusLine = index === focusIndex;
          return (
            <button
              key={line.id}
              type="button"
              ref={(element) => {
                lineButtonRefs.current[index] = element;
              }}
              className={`lyrics-line ${isPlaybackLine ? "is-active" : ""} ${isFocusLine ? "is-focus" : ""}`}
              style={lineStyle(offset, browsing)}
              onClick={(event) => seekToLine(line, event.detail === 0)}
              onFocus={onInteraction}
              aria-current={isPlaybackLine ? "true" : undefined}
              aria-label={`跳转到歌词：${line.text}`}
              tabIndex={visible && distance <= 3 ? 0 : -1}
            >
              <span className="lyrics-line-copy">
                {(line.words ?? [{ text: line.text, start: line.start, end: line.end }]).map((word, wordIndex) => (
                  <span className="lyrics-word" key={`${line.id}-word-${wordIndex}`}>
                    <span className="lyrics-word-base">{word.text}</span>
                    <span
                      className="lyrics-word-progress"
                      ref={(element) => {
                        if (!wordProgressRefs.current[index]) wordProgressRefs.current[index] = [];
                        wordProgressRefs.current[index][wordIndex] = element;
                      }}
                      aria-hidden="true"
                    >
                      {word.text}
                    </span>
                  </span>
                ))}
              </span>
              {line.translation ? <span className="lyrics-translation">{line.translation}</span> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
