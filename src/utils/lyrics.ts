import type { LyricsBackgroundLine, LyricsSource, LyricsDocument, LyricsLine, LyricsWord } from "../types";

type LineDraft = {
  start: number;
  end?: number;
  text: string;
  translation?: string;
  transliteration?: string;
  words?: Array<Omit<LyricsWord, "end"> & { end?: number }>;
  background?: LineDraft[];
};

type XmlElement = {
  attributes: string;
  body: string;
  start: number;
  end: number;
};

const LRC_LINE_TIME = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
const LRC_WORD_TIME = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;

export function parseLyricsSource(
  trackId: string,
  source: LyricsSource,
  duration?: number,
): LyricsDocument | null {
  const hint = inferFormat(source);
  if (hint === "ttml") return parseTtml(trackId, source.source_id, source.content, duration);
  if (hint === "lrc") return parseLrc(trackId, source.source_id, source.content, duration);
  return parsePlain(trackId, source.source_id, source.content);
}

export function parseLrc(
  trackId: string,
  sourceId: string,
  content: string,
  duration?: number,
): LyricsDocument | null {
  const offsetMatch = content.match(/^\s*\[offset:([+-]?\d+)\]\s*$/im);
  const offset = Number(offsetMatch?.[1] ?? 0) / 1_000;
  const drafts: LineDraft[] = [];
  const untimed: string[] = [];

  for (const rawLine of normalizedLines(content)) {
    LRC_LINE_TIME.lastIndex = 0;
    const times = [...rawLine.matchAll(LRC_LINE_TIME)];
    if (times.length === 0) {
      if (!/^\s*\[[a-z][a-z0-9_-]*:/i.test(rawLine) && rawLine.trim()) untimed.push(rawLine.trim());
      continue;
    }

    const body = rawLine.replace(LRC_LINE_TIME, "").trim();
    if (!body) continue;
    for (const timeMatch of times) {
      const start = Math.max(0, lrcTimestamp(timeMatch[1], timeMatch[2]) + offset);
      const words = parseEnhancedLrcWords(body, start, offset);
      const text = words?.map((word) => word.text).join("") || stripInlineTimestamps(body).trim();
      if (!text) continue;
      drafts.push({ start, text, words });
    }
  }

  if (drafts.length === 0) {
    return parsePlain(trackId, sourceId, untimed.length > 0 ? untimed.join("\n") : content);
  }

  return documentFromTimedDrafts(trackId, sourceId, drafts, duration);
}

export function parseTtml(
  trackId: string,
  sourceId: string,
  content: string,
  duration?: number,
): LyricsDocument | null {
  const drafts: LineDraft[] = [];
  const normalizedContent = content.replace(/<!--[\s\S]*?-->/g, "");

  for (const paragraph of xmlElements(normalizedContent, "p")) {
    const draft = ttmlLineDraft(paragraph);
    if (!draft) continue;
    const background = xmlElements(paragraph.body, "span")
      .filter((span) => parseXmlAttributes(span.attributes).role === "x-bg")
      .map((span) => ttmlLineDraft(span, draft.start, draft.end))
      .filter((line): line is LineDraft => Boolean(line));
    if (background.length > 0) draft.background = background;
    drafts.push(draft);
  }

  const timedDrafts = drafts.filter((line) => Number.isFinite(line.start));
  if (timedDrafts.length === 0) {
    const text = drafts.map((line) => line.text).join("\n") || stripXml(content);
    return parsePlain(trackId, sourceId, text);
  }

  return documentFromTimedDrafts(trackId, sourceId, timedDrafts, duration);
}

function ttmlLineDraft(
  element: XmlElement,
  fallbackStart = Number.NaN,
  fallbackEnd?: number,
): LineDraft | null {
  const attributes = parseXmlAttributes(element.attributes);
  const spans = xmlElements(element.body, "span");
  const auxiliary = spans.filter((span) => isAuxiliaryTtmlRole(parseXmlAttributes(span.attributes).role));
  const words: NonNullable<LineDraft["words"]> = [];

  for (const span of spans) {
    const spanAttributes = parseXmlAttributes(span.attributes);
    if (isAuxiliaryTtmlRole(spanAttributes.role)) continue;
    const start = parseTtmlTime(spanAttributes.begin);
    const end = parseTtmlTime(spanAttributes.end);
    const text = stripXml(span.body, false);
    if (start === null || !text.trim()) continue;
    words.push({ text, start, end: end ?? undefined });
  }

  const text = stripXml(removeXmlElements(element.body, auxiliary));
  if (!text) return null;
  const explicitStart = parseTtmlTime(attributes.begin);
  const start = explicitStart ?? words[0]?.start ?? fallbackStart;
  const explicitEnd = parseTtmlTime(attributes.end);
  const durationValue = parseTtmlTime(attributes.dur);
  const end = explicitEnd
    ?? (durationValue !== null && Number.isFinite(start) ? start + durationValue : undefined)
    ?? words[words.length - 1]?.end
    ?? fallbackEnd;

  return {
    start,
    end,
    text,
    translation: auxiliaryTtmlText(auxiliary, "x-translation"),
    transliteration: auxiliaryTtmlText(auxiliary, "x-roman"),
    words: words.length > 0 ? words : undefined,
  };
}

export function parsePlain(trackId: string, sourceId: string, content: string): LyricsDocument | null {
  const lines = normalizedLines(content)
    .map((line) => line.trim())
    .filter(Boolean)
    .map<LyricsLine>((text, index) => ({
      id: `${trackId}-plain-${index}`,
      start: 0,
      end: 0,
      text,
    }));

  if (lines.length === 0) return null;
  return { trackId, sourceId, format: "plain", lines };
}

function documentFromTimedDrafts(
  trackId: string,
  sourceId: string,
  drafts: LineDraft[],
  duration?: number,
): LyricsDocument | null {
  const ordered = [...drafts]
    .filter((line) => line.text.trim() && Number.isFinite(line.start))
    .sort((left, right) => left.start - right.start);
  const merged: LineDraft[] = [];

  for (const draft of ordered) {
    const previous = merged[merged.length - 1];
    if (
      previous
      && Math.abs(previous.start - draft.start) < 0.015
      && !previous.translation
      && previous.text !== draft.text
      && !draft.words
    ) {
      previous.translation = draft.text;
      continue;
    }
    merged.push(draft);
  }

  const lines = merged.map<LyricsLine>((draft, index) => {
    const nextStart = merged[index + 1]?.start;
    const fallbackEnd = nextStart ?? (duration && duration > draft.start ? duration : draft.start + 6);
    const end = draft.end && draft.end > draft.start ? draft.end : Math.max(draft.start + 0.05, fallbackEnd);
    const words = finalizedWords(draft, end);
    const background = draft.background?.map<LyricsBackgroundLine>((backgroundDraft, backgroundIndex) => {
      const backgroundStart = Number.isFinite(backgroundDraft.start)
        ? Math.max(0, backgroundDraft.start)
        : draft.start;
      const backgroundEnd = backgroundDraft.end && backgroundDraft.end > backgroundStart
        ? backgroundDraft.end
        : Math.max(backgroundStart + 0.05, end);
      return {
        id: `${trackId}-lyrics-${index}-background-${backgroundIndex}`,
        start: backgroundStart,
        end: backgroundEnd,
        text: backgroundDraft.text,
        translation: backgroundDraft.translation,
        transliteration: backgroundDraft.transliteration,
        words: finalizedWords({ ...backgroundDraft, start: backgroundStart }, backgroundEnd),
      };
    });
    return {
      id: `${trackId}-lyrics-${index}`,
      start: draft.start,
      end,
      text: draft.text,
      translation: draft.translation,
      transliteration: draft.transliteration,
      words: words?.length ? words : undefined,
      background: background?.length ? background : undefined,
    };
  });

  if (lines.length === 0) return null;
  return {
    trackId,
    sourceId,
    format: lines.some((line) => line.words?.length) ? "word" : "line",
    lines,
  };
}

function finalizedWords(draft: LineDraft, end: number) {
  const words = draft.words?.map<LyricsWord>((word, wordIndex) => {
    const nextWordStart = draft.words?.[wordIndex + 1]?.start;
    return {
      text: word.text,
      start: Math.max(draft.start, word.start),
      end: Math.max(word.start + 0.02, word.end ?? nextWordStart ?? end),
    };
  });
  return words?.length ? words : undefined;
}

function parseEnhancedLrcWords(
  body: string,
  lineStart: number,
  offset: number,
): LineDraft["words"] | undefined {
  LRC_WORD_TIME.lastIndex = 0;
  const matches = [...body.matchAll(LRC_WORD_TIME)];
  if (matches.length === 0) return undefined;

  const words: NonNullable<LineDraft["words"]> = [];
  const prefix = body.slice(0, matches[0].index).trim();
  if (prefix) words.push({ text: prefix, start: lineStart });

  matches.forEach((match, index) => {
    const textStart = (match.index ?? 0) + match[0].length;
    const textEnd = matches[index + 1]?.index ?? body.length;
    const text = stripInlineTimestamps(body.slice(textStart, textEnd));
    if (!text) return;
    words.push({
      text,
      start: Math.max(lineStart, lrcTimestamp(match[1], match[2]) + offset),
    });
  });

  return words.length > 0 ? words : undefined;
}

function parseTtmlTime(value?: string): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const offset = trimmed.match(/^([+-]?\d+(?:\.\d+)?)(h|m|s|ms)$/i);
  if (offset) {
    const amount = Number(offset[1]);
    const unit = offset[2].toLowerCase();
    if (unit === "h") return amount * 3_600;
    if (unit === "m") return amount * 60;
    if (unit === "ms") return amount / 1_000;
    return amount;
  }

  const parts = trimmed.split(":");
  if (parts.length === 3) {
    return Number(parts[0]) * 3_600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
  return Number.isFinite(Number(trimmed)) ? Number(trimmed) : null;
}

function parseXmlAttributes(source: string) {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    const nameParts = match[1].split(":");
    attributes[nameParts[nameParts.length - 1] ?? match[1]] = decodeXml(match[3]);
  }
  return attributes;
}

function auxiliaryTtmlText(
  spans: XmlElement[],
  role: "x-translation" | "x-roman",
) {
  const span = spans.find((candidate) => parseXmlAttributes(candidate.attributes).role === role);
  const text = span ? stripXml(span.body) : "";
  return text || undefined;
}

function xmlElements(source: string, localName: string): XmlElement[] {
  const elements: XmlElement[] = [];
  const tagPattern = /<(\/?)\s*(?:[\w-]+:)?([\w-]+)\b([^>]*)>/gi;
  let depth = 0;
  let opening: { attributes: string; start: number; bodyStart: number } | null = null;

  for (const match of source.matchAll(tagPattern)) {
    if (match[2].toLocaleLowerCase() !== localName.toLocaleLowerCase()) continue;
    const closing = match[1] === "/";
    const selfClosing = !closing && /\/\s*$/.test(match[3]);
    if (selfClosing) continue;

    if (!closing) {
      if (depth === 0) {
        opening = {
          attributes: match[3],
          start: match.index ?? 0,
          bodyStart: (match.index ?? 0) + match[0].length,
        };
      }
      depth += 1;
      continue;
    }

    if (depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || !opening) continue;
    const closingStart = match.index ?? source.length;
    elements.push({
      attributes: opening.attributes,
      body: source.slice(opening.bodyStart, closingStart),
      start: opening.start,
      end: closingStart + match[0].length,
    });
    opening = null;
  }

  return elements;
}

function removeXmlElements(source: string, elements: XmlElement[]) {
  if (elements.length === 0) return source;
  const ordered = [...elements].sort((left, right) => left.start - right.start);
  let cursor = 0;
  let result = "";
  for (const element of ordered) {
    result += source.slice(cursor, element.start);
    cursor = Math.max(cursor, element.end);
  }
  return result + source.slice(cursor);
}

function isAuxiliaryTtmlRole(role?: string) {
  return role === "x-translation" || role === "x-roman" || role === "x-bg";
}

function inferFormat(source: LyricsSource): LyricsSource["format_hint"] {
  const trimmed = source.content.trimStart();
  if (source.format_hint === "ttml" || (trimmed.startsWith("<") && /<(?:[\w-]+:)?tt\b/i.test(trimmed))) {
    return "ttml";
  }
  LRC_LINE_TIME.lastIndex = 0;
  if (source.format_hint === "lrc" || LRC_LINE_TIME.test(source.content)) return "lrc";
  return "plain";
}

function lrcTimestamp(minutes: string, seconds: string) {
  return Number(minutes) * 60 + Number(seconds.replace(":", "."));
}

function stripInlineTimestamps(value: string) {
  LRC_WORD_TIME.lastIndex = 0;
  return value.replace(LRC_WORD_TIME, "");
}

function stripXml(value: string, trim = true) {
  const normalized = decodeXml(
    value
      .replace(/<(?:[\w-]+:)?br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  ).replace(/[\t\r ]+/g, " ").replace(/\s*\n\s*/g, "\n");
  return trim ? normalized.trim() : normalized;
}

function decodeXml(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number: string) => String.fromCodePoint(Number(number)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizedLines(content: string) {
  return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
}
