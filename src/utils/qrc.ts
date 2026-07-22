export type QqLyricsPayload = {
  original: string;
  translation: string;
};

type QrcWord = {
  text: string;
  startMs: number;
  endMs: number;
};

type QrcLine = {
  startMs: number;
  endMs: number;
  words: QrcWord[];
};

const QRC_LINE = /^\[(\d+),(\d+)\](.*)$/;
const QRC_WORD = /(.*?)\((\d+),(\d+)\)/g;
const LRC_TIME = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;

export function parseQqLyricsResponse(response: string): QqLyricsPayload {
  return {
    original: extractElementContent(response, "content"),
    translation: extractElementContent(response, "contentts"),
  };
}

export function extractQrcLyricContent(value: string) {
  const normalized = value.replace(/^\uFEFF/, "").trim();
  if (!/<Lyric_1\b/i.test(normalized)) return normalized;
  const attribute = /<Lyric_1\b[^>]*?\bLyricContent\s*=\s*(["'])/i.exec(normalized);
  if (!attribute) return "";
  const quote = attribute[1];
  const valueStart = (attribute.index ?? 0) + attribute[0].length;
  const elementTail = normalized.slice(valueStart);
  const elementEnd = elementTail.indexOf("/>");
  if (elementEnd < 0) return "";
  const attributeBody = elementTail.slice(0, elementEnd);
  const valueEnd = attributeBody.lastIndexOf(quote);
  return valueEnd >= 0 ? decodeXmlEntities(attributeBody.slice(0, valueEnd)).trim() : "";
}

export function isEncryptedQrc(value: string) {
  const compact = value.replace(/\s/g, "");
  return compact.length >= 16 && compact.length % 16 === 0 && /^[0-9a-f]+$/i.test(compact);
}

export function qrcToTtml(qrc: string, translation?: string | null) {
  const lines = parseQrcLines(qrc);
  if (lines.length === 0) return "";
  const translations = parseLrcTextByTime(translation ?? "");
  const body = lines.map((line) => {
    const words = line.words
      .map((word) => `<span begin="${word.startMs}ms" end="${word.endMs}ms">${escapeXml(word.text)}</span>`)
      .join("");
    const translated = findTimedText(translations, line.startMs);
    const auxiliary = translated
      ? `<span ttm:role="x-translation">${escapeXml(translated)}</span>`
      : "";
    return `<p begin="${line.startMs}ms" end="${line.endMs}ms">${words}${auxiliary}</p>`;
  }).join("");
  return `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div>${body}</div></body></tt>`;
}

function parseQrcLines(content: string) {
  const lines: QrcLine[] = [];
  for (const rawLine of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const lineMatch = rawLine.trim().match(QRC_LINE);
    if (!lineMatch) continue;
    const startMs = Number(lineMatch[1]);
    const durationMs = Number(lineMatch[2]);
    if (!Number.isFinite(startMs) || !Number.isFinite(durationMs) || durationMs <= 0) continue;
    QRC_WORD.lastIndex = 0;
    const words = [...lineMatch[3].matchAll(QRC_WORD)]
      .map((match): QrcWord | null => {
        const wordStartMs = Number(match[2]);
        const wordDurationMs = Number(match[3]);
        if (!match[1] || !Number.isFinite(wordStartMs) || !Number.isFinite(wordDurationMs)) return null;
        const start = Math.max(startMs, wordStartMs);
        return {
          text: match[1],
          startMs: start,
          endMs: Math.max(start + 20, wordStartMs + wordDurationMs),
        };
      })
      .filter((word): word is QrcWord => word !== null);
    if (words.length === 0) continue;
    lines.push({
      startMs,
      endMs: Math.max(startMs + 50, startMs + durationMs, words[words.length - 1].endMs),
      words,
    });
  }
  return lines;
}

function parseLrcTextByTime(content: string) {
  const result: Array<{ timeMs: number; text: string }> = [];
  for (const rawLine of content.split(/\r?\n/)) {
    LRC_TIME.lastIndex = 0;
    const times = [...rawLine.matchAll(LRC_TIME)];
    if (times.length === 0) continue;
    const text = rawLine.replace(LRC_TIME, "").trim();
    if (!text || text === "//") continue;
    for (const time of times) {
      const seconds = Number(time[2].replace(":", "."));
      if (!Number.isFinite(seconds)) continue;
      result.push({ timeMs: Number(time[1]) * 60_000 + Math.round(seconds * 1_000), text });
    }
  }
  return result;
}

function findTimedText(values: Array<{ timeMs: number; text: string }>, timeMs: number) {
  return values.find((value) => Math.abs(value.timeMs - timeMs) <= 80)?.text;
}

function extractElementContent(response: string, tagName: string) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const body = response.match(pattern)?.[1]?.trim() ?? "";
  const cdata = body.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
  return decodeXmlEntities(cdata?.[1] ?? body).trim();
}

function decodeXmlEntities(value: string) {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (entity, decimal, hexadecimal, named) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
    const replacements: Record<string, string> = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      quot: '"',
    };
    return replacements[String(named).toLowerCase()] ?? entity;
  });
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
