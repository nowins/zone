import type {
  Playlist,
  SmartPlaylist,
  SmartPlaylistConfig,
  SmartRule,
  SmartRuleField,
  Track,
  TrackActivity,
  TrackActivityMap,
} from "../types";

export type SmartPlaylistContext = {
  favoriteTrackIds: ReadonlySet<string>;
  activity: TrackActivityMap;
  now?: number;
  /** Optional lookup built from the same track array for a batch of list resolutions. */
  trackById?: ReadonlyMap<string, Track>;
};

export type SmartPlaylistResult = {
  tracks: Track[];
  matchedCount: number;
  durationSeconds: number;
  missingMetadataCount: number;
};

export type SmartPlaylistPreset = {
  id: string;
  name: string;
  description: string;
  config: SmartPlaylistConfig;
};

const DAY_MS = 86_400_000;

export function defaultSmartPlaylistConfig(): SmartPlaylistConfig {
  return {
    match: "all",
    rules: [],
    order: "smart",
    limitKind: "tracks",
    limitValue: 50,
    maxPerArtist: 3,
    maxPerAlbum: 2,
    preferFavorites: true,
    avoidSkipped: true,
    rotateDaily: true,
    rotationSeed: 0,
  };
}

export function smartPlaylistPresets(): SmartPlaylistPreset[] {
  const base = defaultSmartPlaylistConfig();
  return [
    {
      id: "forgotten-favorites",
      name: "久违的收藏",
      description: "收藏中超过 30 天没听的歌曲",
      config: {
        ...base,
        rules: [
          smartRule("favorite", "is", true),
          smartRule("lastPlayed", "olderThanDays", 30),
        ],
        order: "oldestPlayed",
      },
    },
    {
      id: "recent-unplayed",
      name: "最近加入",
      description: "最近 30 天加入且还没播放过",
      config: {
        ...base,
        rules: [
          smartRule("dateAdded", "withinDays", 30),
          smartRule("playCount", "equals", 0),
        ],
        order: "recentlyAdded",
      },
    },
    {
      id: "rediscover",
      name: "发现旧爱",
      description: "听过几次，但已经很久没再播放",
      config: {
        ...base,
        rules: [
          smartRule("playCount", "atLeast", 2),
          smartRule("lastPlayed", "olderThanDays", 90),
        ],
        order: "smart",
      },
    },
    {
      id: "least-played",
      name: "冷门角落",
      description: "从播放次数最少的音乐开始",
      config: {
        ...base,
        order: "leastPlayed",
      },
    },
    {
      id: "one-hour",
      name: "一小时随心听",
      description: "兼顾收藏、新鲜度与艺术家分散",
      config: {
        ...base,
        limitKind: "minutes",
        limitValue: 60,
        maxPerArtist: 2,
        maxPerAlbum: 1,
      },
    },
  ];
}

export function smartRule(
  field: SmartRuleField,
  operator: SmartRule["operator"],
  value?: SmartRule["value"],
  valueTo?: number,
): SmartRule {
  return {
    id: `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    field,
    operator,
    value,
    valueTo,
  };
}

export function isSmartPlaylist(playlist: Playlist): playlist is SmartPlaylist {
  return playlist.kind === "smart";
}

export function normalizeSmartPlaylistConfig(config?: Partial<SmartPlaylistConfig> | null): SmartPlaylistConfig {
  const defaults = defaultSmartPlaylistConfig();
  return {
    ...defaults,
    ...config,
    rules: Array.isArray(config?.rules) ? config.rules : defaults.rules,
    limitValue: positiveNumber(config?.limitValue, defaults.limitValue),
    maxPerArtist: nonNegativeNumber(config?.maxPerArtist, defaults.maxPerArtist),
    maxPerAlbum: nonNegativeNumber(config?.maxPerAlbum, defaults.maxPerAlbum),
    rotationSeed: nonNegativeNumber(config?.rotationSeed, defaults.rotationSeed),
  };
}

export function resolvePlaylistTracks(
  playlist: Playlist,
  tracks: Track[],
  context: SmartPlaylistContext,
): SmartPlaylistResult {
  if (!isSmartPlaylist(playlist)) {
    const trackMap = context.trackById ?? new Map(tracks.map((track) => [track.id, track]));
    const resolved = playlist.trackIds.map((id) => trackMap.get(id)).filter(Boolean) as Track[];
    return summarize(resolved, resolved.length, 0);
  }

  return evaluateSmartPlaylist(playlist.smart, tracks, context, new Set(playlist.excludedTrackIds));
}

export function evaluateSmartPlaylist(
  rawConfig: SmartPlaylistConfig,
  tracks: Track[],
  context: SmartPlaylistContext,
  excludedTrackIds: ReadonlySet<string> = new Set(),
): SmartPlaylistResult {
  const config = normalizeSmartPlaylistConfig(rawConfig);
  const now = context.now ?? Date.now();
  const matched = tracks.filter((track) =>
    !excludedTrackIds.has(track.id) && matchesRules(track, config, context, now),
  );
  const activeRules = config.rules.filter(isRuleComplete);
  const missingMetadataCount = tracks.filter((track) =>
    !excludedTrackIds.has(track.id) &&
    activeRules.some((rule) => isMetadataMissing(track, rule.field, rule.value)),
  ).length;
  const ordered = orderTracks(matched, config, context, now);
  const selected = diversifyAndLimit(ordered, config);
  return summarize(selected, matched.length, missingMetadataCount);
}

export function describeSmartPlaylist(config: SmartPlaylistConfig) {
  const normalized = normalizeSmartPlaylistConfig(config);
  const activeRules = normalized.rules.filter(isRuleComplete);
  if (activeRules.length === 0) return "整个音乐库的智能混合";
  const joiner = normalized.match === "all" ? "，且" : "，或";
  return activeRules.map(describeRule).join(joiner);
}

export function describeRule(rule: SmartRule) {
  const value = String(rule.value ?? "");
  const fieldLabel: Record<SmartRuleField, string> = {
    artist: "艺术家",
    album: "专辑",
    genre: "风格",
    year: "年代",
    favorite: "收藏",
    playCount: "播放次数",
    lastPlayed: "最近播放",
    dateAdded: "加入时间",
    skipRate: "跳过率",
  };
  const prefix = fieldLabel[rule.field];
  if (rule.operator === "contains") return `${prefix}包含 ${value}`;
  if (rule.operator === "notContains") return `${prefix}不含 ${value}`;
  if (rule.operator === "equals") return rule.field === "playCount"
    ? `播放次数等于 ${value}`
    : `${prefix}是 ${value}`;
  if (rule.operator === "between") return `${prefix}在 ${value}–${rule.valueTo ?? value}`;
  if (rule.operator === "atLeast") return rule.field === "skipRate"
    ? `跳过率不低于 ${value}%`
    : `${prefix}不少于 ${value}`;
  if (rule.operator === "atMost") return rule.field === "skipRate"
    ? `跳过率不高于 ${value}%`
    : `${prefix}不多于 ${value}`;
  if (rule.operator === "never") return "从未播放";
  if (rule.operator === "olderThanDays") return rule.field === "dateAdded"
    ? `加入已超过 ${value} 天`
    : `${value} 天以上没听`;
  if (rule.operator === "withinDays") return `${prefix}在最近 ${value} 天`;
  if (rule.operator === "is") return rule.value ? "已收藏" : "未收藏";
  return prefix;
}

export function createTrackActivity(existing: Partial<TrackActivity> | undefined, now = Date.now()): TrackActivity {
  return {
    addedAt: positiveNumber(existing?.addedAt, now),
    playCount: nonNegativeNumber(existing?.playCount, 0),
    completedCount: nonNegativeNumber(existing?.completedCount, 0),
    skipCount: nonNegativeNumber(existing?.skipCount, 0),
    lastPlayedAt: validTimestamp(existing?.lastPlayedAt),
    lastSkippedAt: validTimestamp(existing?.lastSkippedAt),
  };
}

function matchesRules(
  track: Track,
  config: SmartPlaylistConfig,
  context: SmartPlaylistContext,
  now: number,
) {
  const activeRules = config.rules.filter(isRuleComplete);
  if (activeRules.length === 0) return true;
  const results = activeRules.map((rule) => matchesRule(track, rule, context, now));
  return config.match === "all" ? results.every(Boolean) : results.some(Boolean);
}

function matchesRule(track: Track, rule: SmartRule, context: SmartPlaylistContext, now: number) {
  const activity = context.activity[track.id];
  if (rule.field === "favorite") {
    return context.favoriteTrackIds.has(track.id) === Boolean(rule.value);
  }

  if (rule.field === "artist" || rule.field === "album" || rule.field === "genre") {
    const target = normalizeText(String(rule.value ?? ""));
    if (!target) return true;
    const values = rule.field === "artist"
      ? [track.artist, track.album_artist ?? ""]
      : rule.field === "album"
        ? [track.album]
        : track.genres ?? [];
    const normalized = values.map(normalizeText);
    if (rule.operator === "equals") return normalized.some((value) => value === target);
    if (rule.operator === "notContains") return normalized.every((value) => !value.includes(target));
    return normalized.some((value) => value.includes(target));
  }

  if (rule.field === "year") {
    if (!track.year) return false;
    const value = numericValue(rule.value);
    if (rule.operator === "between") return track.year >= value && track.year <= numericValue(rule.valueTo);
    if (rule.operator === "atLeast") return track.year >= value;
    if (rule.operator === "atMost") return track.year <= value;
    return track.year === value;
  }

  if (rule.field === "playCount") {
    return compareNumber(activity?.playCount ?? 0, rule.operator, numericValue(rule.value));
  }

  if (rule.field === "skipRate") {
    const attempts = (activity?.playCount ?? 0) + (activity?.skipCount ?? 0);
    const rate = attempts > 0 ? ((activity?.skipCount ?? 0) / attempts) * 100 : 0;
    return compareNumber(rate, rule.operator, numericValue(rule.value));
  }

  if (rule.field === "lastPlayed") {
    if (rule.operator === "never") return !activity?.lastPlayedAt;
    if (!activity?.lastPlayedAt) return rule.operator === "olderThanDays";
    return compareAge(activity.lastPlayedAt, rule.operator, numericValue(rule.value), now);
  }

  if (rule.field === "dateAdded") {
    return compareAge(activity?.addedAt ?? now, rule.operator, numericValue(rule.value), now);
  }

  return true;
}

function compareNumber(actual: number, operator: SmartRule["operator"], expected: number) {
  if (operator === "atLeast") return actual >= expected;
  if (operator === "atMost") return actual <= expected;
  return actual === expected;
}

function compareAge(timestamp: number, operator: SmartRule["operator"], days: number, now: number) {
  const age = Math.max(0, now - timestamp) / DAY_MS;
  if (operator === "withinDays") return age <= days;
  return age >= days;
}

function orderTracks(
  tracks: Track[],
  config: SmartPlaylistConfig,
  context: SmartPlaylistContext,
  now: number,
) {
  const date = new Date(now);
  const daySeed = config.rotateDaily
    ? date.getFullYear() * 372 + date.getMonth() * 31 + date.getDate()
    : 0;
  return [...tracks].sort((a, b) => {
    const activityA = context.activity[a.id];
    const activityB = context.activity[b.id];
    if (config.order === "leastPlayed") {
      return (activityA?.playCount ?? 0) - (activityB?.playCount ?? 0) || stableTie(a, b);
    }
    if (config.order === "oldestPlayed") {
      return (activityA?.lastPlayedAt ?? 0) - (activityB?.lastPlayedAt ?? 0) || stableTie(a, b);
    }
    if (config.order === "recentlyAdded") {
      return (activityB?.addedAt ?? 0) - (activityA?.addedAt ?? 0) || stableTie(a, b);
    }
    if (config.order === "title") return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    return smartScore(b, activityB, config, context, now, daySeed)
      - smartScore(a, activityA, config, context, now, daySeed)
      || stableTie(a, b);
  });
}

function smartScore(
  track: Track,
  activity: TrackActivity | undefined,
  config: SmartPlaylistConfig,
  context: SmartPlaylistContext,
  now: number,
  daySeed: number,
) {
  const daysSincePlayed = activity?.lastPlayedAt
    ? Math.min(180, Math.max(0, now - activity.lastPlayedAt) / DAY_MS)
    : 180;
  const attempts = (activity?.playCount ?? 0) + (activity?.skipCount ?? 0);
  const skipRate = attempts > 0 ? (activity?.skipCount ?? 0) / attempts : 0;
  const freshness = Math.max(0, 16 - (activity?.playCount ?? 0) * 1.6);
  const favorite = config.preferFavorites && context.favoriteTrackIds.has(track.id) ? 24 : 0;
  const skipPenalty = config.avoidSkipped ? skipRate * 34 : 0;
  const rotation = seededUnit(`${track.id}:${config.rotationSeed}:${daySeed}`) * 22;
  return daysSincePlayed / 5 + freshness + favorite + rotation - skipPenalty;
}

function diversifyAndLimit(tracks: Track[], config: SmartPlaylistConfig) {
  const artistCounts = new Map<string, number>();
  const albumCounts = new Map<string, number>();
  const result: Track[] = [];
  let durationSeconds = 0;
  const durationLimit = config.limitKind === "minutes" ? config.limitValue * 60 : Number.POSITIVE_INFINITY;
  const trackLimit = config.limitKind === "tracks" ? config.limitValue : Number.POSITIVE_INFINITY;

  for (const track of tracks) {
    const artistKey = normalizeText(track.album_artist || track.artist || "未知艺术家");
    const albumKey = `${normalizeText(track.album)}\u0000${artistKey}`;
    if (config.maxPerArtist > 0 && (artistCounts.get(artistKey) ?? 0) >= config.maxPerArtist) continue;
    if (config.maxPerAlbum > 0 && (albumCounts.get(albumKey) ?? 0) >= config.maxPerAlbum) continue;
    const trackDuration = track.duration_seconds ?? 210;
    if (result.length > 0 && durationSeconds + trackDuration > durationLimit) continue;

    result.push(track);
    durationSeconds += trackDuration;
    artistCounts.set(artistKey, (artistCounts.get(artistKey) ?? 0) + 1);
    albumCounts.set(albumKey, (albumCounts.get(albumKey) ?? 0) + 1);
    if (result.length >= trackLimit || durationSeconds >= durationLimit) break;
  }

  return result;
}

function summarize(tracks: Track[], matchedCount: number, missingMetadataCount: number): SmartPlaylistResult {
  return {
    tracks,
    matchedCount,
    durationSeconds: tracks.reduce((total, track) => total + (track.duration_seconds ?? 0), 0),
    missingMetadataCount,
  };
}

function isMetadataMissing(track: Track, field: SmartRuleField, value?: SmartRule["value"]) {
  if ((field === "genre" || field === "artist" || field === "album") && !String(value ?? "").trim()) return false;
  if (field === "genre") return !track.genres?.length;
  if (field === "year") return !track.year;
  return false;
}

function isRuleComplete(rule: SmartRule) {
  if (rule.operator === "never" || rule.field === "favorite") return true;
  if (rule.field === "artist" || rule.field === "album" || rule.field === "genre") {
    return Boolean(String(rule.value ?? "").trim());
  }
  if (!Number.isFinite(Number(rule.value))) return false;
  return rule.operator !== "between" || Number.isFinite(Number(rule.valueTo));
}

function normalizeText(value: string) {
  return value.trim().toLocaleLowerCase();
}

function numericValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function validTimestamp(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function seededUnit(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4_294_967_295;
}

function stableTie(a: Track, b: Track) {
  return a.id.localeCompare(b.id);
}
