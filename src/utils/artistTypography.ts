import { clamp } from "../motion/math.js";
import { irisEaseIn, irisLogarithmic } from "../motion/irisCurves.js";
import { NOW_PLAYING_CURVES, NOW_PLAYING_MOTION } from "../motion/tokens.js";
import type { Track } from "../types";

export type ArtistTypographyKind = "letters" | "lines" | "cluster" | "angled";
export type ArtistTypographyModel = { key: string; artist: string; album: string; title: string; text: string[] };
export type ArtistTypographyClip = { id: number; kind: ArtistTypographyKind; model: ArtistTypographyModel; originMs: number };
export type ArtistTypographyClock = {
  current: ArtistTypographyClip; previous: ArtistTypographyClip | null; transitionMs: number;
};
export type ArtistTypographyLine = {
  text: string; size: number; weight: number; x: number; y: number; angle: number;
  index: number; phase: number; wrap: boolean;
};
const KINDS: readonly ArtistTypographyKind[] = ["letters", "lines", "cluster", "angled"];
export const ARTIST_TEXT_REFERENCE = { width: 800, height: 600 };
export const MAX_ARTIST_TEXT_GRAPHEMES = 48;

/** Names come from local tags; online biographies and statistics are excluded. */
export function artistTypographyModel(track: Track | null): ArtistTypographyModel {
  const clean = (value: string | null | undefined) => {
    const text = (value ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().toLocaleUpperCase();
    const glyphs = artistTextGraphemes(text);
    return glyphs.length > MAX_ARTIST_TEXT_GRAPHEMES ? glyphs.slice(0, MAX_ARTIST_TEXT_GRAPHEMES - 1).join("") + "…" : text;
  };
  const artist = clean(track?.album_artist || track?.artist), album = clean(track?.album), title = clean(track?.title);
  const text = [...new Set([title, album, artist].filter(Boolean))];
  return { key: JSON.stringify([artist, album, title]), artist, album, title, text };
}

export function artistTextGraphemes(text: string): string[] {
  type Segmenter = { segment(value: string): Iterable<{ segment: string }> };
  const Constructor = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => Segmenter }).Segmenter;
  if (Constructor) return Array.from(new Constructor(undefined, { granularity: "grapheme" }).segment(text), item => item.segment);
  return Array.from(text.normalize("NFC"));
}

export function createArtistTypographyClock(model: ArtistTypographyModel, originMs: number,
  previousKind?: ArtistTypographyKind, random = Math.random): ArtistTypographyClock {
  const options = KINDS.filter(kind => kind !== previousKind);
  const kind = options[Math.min(options.length - 1, Math.max(0, Math.floor(random() * options.length)))];
  return { current: { id: 0, kind, model, originMs }, previous: null, transitionMs: NOW_PLAYING_MOTION.artistTextRetarget };
}

/** A metadata change dissolves only the text, preserving the photograph's clock. */
export function advanceArtistTypography(clock: ArtistTypographyClock, model: ArtistTypographyModel,
  elapsedMs: number, deltaMs: number, reduced: boolean, playing = true) {
  if (clock.current.model.key !== model.key) {
    // Finish an in-flight text handoff before applying its latest model.
    if (!clock.previous) {
      clock.previous = clock.current;
      clock.current = { ...clock.current, id: clock.current.id + 1, model,
        originMs: elapsedMs - (playing ? 0 : NOW_PLAYING_MOTION.artistScene * NOW_PLAYING_CURVES.artistText.staticProgress) };
      clock.transitionMs = 0;
    }
  }
  if (clock.previous) {
    clock.transitionMs = reduced ? NOW_PLAYING_MOTION.artistTextRetarget : clock.transitionMs + Math.max(0, deltaMs);
    if (clock.transitionMs >= NOW_PLAYING_MOTION.artistTextRetarget) clock.previous = null;
  }
}

export function artistTypographyLayers(clock: ArtistTypographyClock) {
  const amount = clamp(clock.transitionMs / NOW_PLAYING_MOTION.artistTextRetarget, 0, 1);
  return clock.previous ? [{ clip: clock.previous, opacity: 1 - amount }, { clip: clock.current, opacity: amount }]
    : [{ clip: clock.current, opacity: 1 }];
}

/** Reference sizes and angles follow NowPlayingClips; packing is viewport-adapted. */
export function artistTypographyLines(kind: ArtistTypographyKind, model: ArtistTypographyModel): ArtistTypographyLine[] {
  const line = (text: string, size: number, x: number, y: number, index: number, phase = 0, angle = 0, wrap = false, weight = 400) =>
    ({ text, size, x, y, index, phase, angle, wrap, weight });
  if (kind === "letters") return model.text.map((text, i) => line(text, i === 1 ? 140 : 42,
    i === 1 ? 320 : 400, [300, 336, 252][i], i, 0, 0, false, i === 1 ? 600 : 400));
  if (kind === "lines") return model.text.map((text, i) => line(text, i === 0 ? 80 : 42, 36, 100 + i * 94, i, 0, 0, true));
  if (kind === "cluster") return [
    line(model.artist, 72, 80, 150, 0), line(model.album, 72, 80, 242, 1), line(model.title, 72, 80, 334, 2),
    line(model.artist, 72, 260, 164, 0, 1), line(model.album, 50, 260, 256, 1, 1), line(model.title, 50, 260, 324, 2, 1),
  ].filter(value => value.text);
  return [
    line(model.artist, 140, 112, 340, 0, 0, -Math.PI / 4, false, 600),
    line(model.album, 72, 172, 398, 1, 0, -Math.PI / 4),
    line(model.title, 36, 70, 340, 2, 0, -Math.PI / 4),
    line(model.artist, 50, 160, 168, 0, 1), line(model.album, 24, 160, 238, 1, 1),
    line(model.title, 21, 160, 282, 2, 1),
  ].filter(value => value.text);
}

export function artistTypographyFrame(kind: ArtistTypographyKind, line: ArtistTypographyLine,
  glyphIndex: number, glyphCount: number, elapsedMs: number, reduced: boolean) {
  const duration = NOW_PLAYING_MOTION.artistScene;
  const phases = kind === "cluster" || kind === "angled";
  const phaseDuration = phases ? duration / 2 : duration;
  const curve = NOW_PLAYING_CURVES.artistText;
  const time = reduced ? phaseDuration * curve.staticProgress : elapsedMs - line.phase * phaseDuration;
  if ((reduced && line.phase !== 0) || time < 0 || time >= phaseDuration) return { x: 0, y: 0, opacity: 0 };
  if (kind === "letters" || kind === "lines") {
    const delay = duration * (kind === "letters" ? line.index * .15 : (line.index + 1) * .1);
    const show = duration * (kind === "letters" ? .2 : .1);
    // Bound long local names so their last grapheme can enter before the exit.
    const stagger = Math.min(duration * (kind === "letters" ? .03 : .015),
      Math.max(0, phaseDuration * .8 - delay - show) / Math.max(1, glyphCount - 1));
    const local = time - delay - glyphIndex * stagger;
    const opacity = reduced ? 1 : irisEaseIn(local / show, curve.fadeWeight, curve.handle) * clamp((duration - time) / (duration * .1), 0, 1);
    return { x: kind === "letters" && !reduced ? -[1200, 600, 800][line.index] * time / duration : 0, y: 0, opacity };
  }
  const progress = time / phaseDuration;
  const enter = irisEaseIn(progress / (kind === "cluster" ? .05 : .02), curve.fadeWeight, curve.handle);
  const exit = clamp((1 - progress) / (kind === "cluster" ? .05 : .01), 0, 1);
  const slide = reduced ? 0 : kind === "angled"
    ? 200 * (1 - irisLogarithmic(clamp(progress / .1, 0, 1), curve.slideWeight))
    : -10 + progress * 20;
  return { x: slide, y: 0, opacity: enter * exit };
}
