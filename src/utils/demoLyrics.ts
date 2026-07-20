import type { LyricsDocument, LyricsWord, Track } from "../types";

type DemoLine = {
  parts: string[];
  translation?: string;
};

// Phase-one motion prototype only. Real documents will replace this through the
// local/provider pipeline described in docs/lyrics-experience-plan.md.
const DEMO_LINES: DemoLine[] = [
  { parts: ["夜色", "把", "街道", "慢慢", "点亮"] },
  { parts: ["风", "从", "半开的", "车窗", "经过"] },
  { parts: ["我们", "把", "没说完的", "话", "留在", "歌里"] },
  { parts: ["让", "低频", "沿着", "城市", "呼吸"] },
  { parts: ["每一束", "光", "都有", "它的", "方向"] },
  { parts: ["每一次", "停顿", "都靠近", "心跳"] },
  { parts: ["别急着", "抵达", "让旋律", "再走一会"] },
  { parts: ["在", "喧闹", "熄灭", "以前"] },
  { parts: ["记住", "此刻", "正在发生"] },
  { parts: ["就让", "回声", "带我们", "向前"] },
  { parts: ["直到", "最后一盏", "灯", "渐远"] },
  { parts: ["歌还在", "我们也", "还在"] },
];

function createWords(parts: string[], start: number, end: number): LyricsWord[] {
  const weights = parts.map((part) => Math.max(1, Array.from(part).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const usableEnd = start + (end - start) * 0.88;
  let cursor = start;

  return parts.map((text, index) => {
    const share = weights[index] / totalWeight;
    const wordEnd = index === parts.length - 1 ? usableEnd : cursor + (usableEnd - start) * share;
    const word = { text, start: cursor, end: wordEnd };
    cursor = wordEnd;
    return word;
  });
}

export function createDemoLyrics(track: Track, duration: number): LyricsDocument {
  const safeDuration = Math.max(45, duration || track.duration_seconds || 210);
  const leadIn = Math.min(8, safeDuration * 0.045);
  const tail = Math.min(10, safeDuration * 0.055);
  const lyricDuration = Math.max(30, safeDuration - leadIn - tail);
  const lineDuration = lyricDuration / DEMO_LINES.length;

  return {
    trackId: track.id,
    sourceId: "zone-motion-prototype",
    format: "word",
    language: "zh-Hans",
    lines: DEMO_LINES.map((line, index) => {
      const start = leadIn + lineDuration * index;
      const end = index === DEMO_LINES.length - 1 ? safeDuration - tail : leadIn + lineDuration * (index + 1);
      return {
        id: `${track.id}-demo-${index}`,
        start,
        end,
        text: line.parts.join(""),
        translation: line.translation,
        words: createWords(line.parts, start, end),
      };
    }),
  };
}
