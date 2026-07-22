import type {
  LyricsBackgroundLine,
  LyricsDocument,
  LyricsLine,
  LyricsWord,
} from "../types.js";

export type LyricsExportFormat = "ttml" | "lrc";

export function serializeLyricsDocument(
  document: LyricsDocument,
  format: LyricsExportFormat,
  timingOffsetMs = 0,
) {
  return format === "ttml"
    ? serializeTtml(document, timingOffsetMs)
    : serializeLrc(document, timingOffsetMs);
}

export function lyricsExportFileName(title: string, format: LyricsExportFormat) {
  const safeTitle = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "歌词";
  return `${safeTitle}.${format}`;
}

function serializeTtml(document: LyricsDocument, timingOffsetMs: number) {
  const lines = document.lines.map((line) => ttmlLine(line, document.format, timingOffsetMs));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">',
    "  <body>",
    "    <div>",
    ...lines,
    "    </div>",
    "  </body>",
    "</tt>",
    "",
  ].join("\n");
}

function ttmlLine(line: LyricsLine, format: LyricsDocument["format"], timingOffsetMs: number) {
  const timed = format !== "plain";
  const attributes = timed
    ? ` begin="${ttmlTime(shiftTime(line.start, timingOffsetMs))}" end="${ttmlTime(shiftEnd(line.start, line.end, timingOffsetMs))}"`
    : "";
  const content: string[] = [];
  if (line.words?.length) {
    content.push(`        ${line.words.map((word) => ttmlWord(word, timingOffsetMs)).join("")}`);
  } else {
    content.push(`        ${escapeXml(line.text)}`);
  }
  content.push(...(line.background ?? []).map((background) => ttmlBackground(background, timingOffsetMs)));
  if (line.translation) {
    content.push(`        <span ttm:role="x-translation">${escapeXml(line.translation)}</span>`);
  }
  if (line.transliteration) {
    content.push(`        <span ttm:role="x-roman">${escapeXml(line.transliteration)}</span>`);
  }
  return [
    `      <p${attributes}>`,
    ...content,
    "      </p>",
  ].join("\n");
}

function ttmlBackground(background: LyricsBackgroundLine, timingOffsetMs: number) {
  const content = background.words?.length
    ? [`          ${background.words.map((word) => ttmlWord(word, timingOffsetMs)).join("")}`]
    : [`          ${escapeXml(background.text)}`];
  if (background.translation) {
    content.push(`          <span ttm:role="x-translation">${escapeXml(background.translation)}</span>`);
  }
  if (background.transliteration) {
    content.push(`          <span ttm:role="x-roman">${escapeXml(background.transliteration)}</span>`);
  }
  return [
    `        <span ttm:role="x-bg" begin="${ttmlTime(shiftTime(background.start, timingOffsetMs))}" end="${ttmlTime(shiftEnd(background.start, background.end, timingOffsetMs))}">`,
    ...content,
    "        </span>",
  ].join("\n");
}

function ttmlWord(word: LyricsWord, timingOffsetMs: number) {
  return `<span begin="${ttmlTime(shiftTime(word.start, timingOffsetMs))}" end="${ttmlTime(shiftEnd(word.start, word.end, timingOffsetMs))}">${escapeXml(word.text)}</span>`;
}

function serializeLrc(document: LyricsDocument, timingOffsetMs: number) {
  if (document.format === "plain") {
    return `${document.lines.map((line) => singleLine(line.text)).join("\n")}\n`;
  }
  const lines: string[] = [];
  for (const line of document.lines) {
    const timestamp = lrcTime(shiftTime(line.start, timingOffsetMs));
    const text = line.words?.length
      ? line.words.map((word) => `<${lrcTime(shiftTime(word.start, timingOffsetMs))}>${singleLine(word.text)}`).join("")
      : singleLine(line.text);
    lines.push(`[${timestamp}]${text}`);
    if (line.translation) lines.push(`[${timestamp}]${singleLine(line.translation)}`);
  }
  return `${lines.join("\n")}\n`;
}

function shiftTime(value: number, timingOffsetMs: number) {
  return Math.max(0, value + timingOffsetMs / 1_000);
}

function shiftEnd(start: number, end: number, timingOffsetMs: number) {
  const shiftedStart = shiftTime(start, timingOffsetMs);
  return Math.max(shiftedStart + 0.001, shiftTime(end, timingOffsetMs));
}

function ttmlTime(value: number) {
  const formatted = value.toFixed(3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return `${formatted}s`;
}

function lrcTime(value: number) {
  const milliseconds = Math.max(0, Math.round(value * 1_000));
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const fraction = milliseconds % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
}

function singleLine(value: string) {
  return value.replace(/[\r\n]+/g, " ");
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
