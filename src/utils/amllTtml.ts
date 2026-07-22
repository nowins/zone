export type AmllTtmlIndexEntry = {
  rawLyricFile: string;
  title: string;
  artist: string;
  album?: string;
  neteaseId?: string;
};

type RawAmllIndexEntry = {
  metadata?: unknown;
  rawLyricFile?: unknown;
};

export function parseAmllTtmlIndex(content: string): AmllTtmlIndexEntry[] {
  const entries: AmllTtmlIndexEntry[] = [];
  for (const line of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw: RawAmllIndexEntry;
    try {
      raw = JSON.parse(line) as RawAmllIndexEntry;
    } catch {
      continue;
    }
    if (
      typeof raw.rawLyricFile !== "string"
      || !/^[a-zA-Z0-9._-]+\.ttml$/.test(raw.rawLyricFile)
    ) {
      continue;
    }
    const metadata = parseMetadata(raw.metadata);
    const title = metadata.get("musicName")?.[0]?.trim();
    const artists = metadata.get("artists")?.map((value) => value.trim()).filter(Boolean) ?? [];
    if (!title || artists.length === 0) continue;
    const album = metadata.get("album")?.[0]?.trim();
    const neteaseId = metadata.get("ncmMusicId")?.[0]?.trim();
    entries.push({
      rawLyricFile: raw.rawLyricFile,
      title,
      artist: artists.join(" / "),
      album: album || undefined,
      neteaseId: neteaseId || undefined,
    });
  }
  return entries;
}

function parseMetadata(value: unknown) {
  const metadata = new Map<string, string[]>();
  if (!Array.isArray(value)) return metadata;
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !Array.isArray(item[1])) {
      continue;
    }
    const values = item[1].filter((entry): entry is string => typeof entry === "string");
    metadata.set(item[0], values);
  }
  return metadata;
}
