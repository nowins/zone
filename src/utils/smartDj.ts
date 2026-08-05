import type { Track, TrackActivity, TrackActivityMap } from "../types.js";
import { createTrackActivity } from "./smartPlaylist.js";

export type SmartDjSeedKind = "track" | "album" | "artist" | "playlist" | "mixed";

export type SmartDjSeed = {
  kind: SmartDjSeedKind;
  id: string;
  label: string;
  tracks: Track[];
};

export type SmartDjConstraints = {
  preferFavorites: boolean;
  avoidHighSkip: boolean;
  maxPerArtist: number;
  maxPerAlbum: number;
  horizon: number;
};

export type SmartDjSession = {
  id: string;
  seed: SmartDjSeed;
  status: "idle" | "playing" | "exhausted" | "stopped";
  playedIds: string[];
  bannedIds: string[];
  queuedIds: string[];
  constraints: SmartDjConstraints;
  createdAt: number;
  updatedAt: number;
};

export type SmartDjContext = {
  tracks: Track[];
  activity: TrackActivityMap;
  favoriteTrackIds: ReadonlySet<string>;
  now?: number;
};

export type SmartDjCandidate = {
  track: Track;
  score: number;
  reasons: string[];
};

const DEFAULT_CONSTRAINTS: SmartDjConstraints = {
  preferFavorites: true,
  avoidHighSkip: true,
  maxPerArtist: 2,
  maxPerAlbum: 1,
  horizon: 12,
};

export function defaultSmartDjConstraints(
  overrides: Partial<SmartDjConstraints> = {},
): SmartDjConstraints {
  return {
    ...DEFAULT_CONSTRAINTS,
    ...overrides,
    maxPerArtist: Math.max(1, overrides.maxPerArtist ?? DEFAULT_CONSTRAINTS.maxPerArtist),
    maxPerAlbum: Math.max(1, overrides.maxPerAlbum ?? DEFAULT_CONSTRAINTS.maxPerAlbum),
    horizon: Math.max(4, overrides.horizon ?? DEFAULT_CONSTRAINTS.horizon),
  };
}

export function createSmartDjSession(
  seed: SmartDjSeed,
  constraints: Partial<SmartDjConstraints> = {},
  now = Date.now(),
): SmartDjSession {
  const seedTrackIds = uniqueIds(seed.tracks.map((track) => track.id));
  return {
    id: `smartdj-${seed.kind}-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    seed: {
      ...seed,
      tracks: seed.tracks.slice(),
    },
    status: "idle",
    playedIds: [],
    bannedIds: [],
    queuedIds: seedTrackIds.slice(0, 1),
    constraints: defaultSmartDjConstraints(constraints),
    createdAt: now,
    updatedAt: now,
  };
}

export function buildSmartDjQueue(
  session: SmartDjSession,
  context: SmartDjContext,
): Track[] {
  const trackMap = new Map(context.tracks.map((track) => [track.id, track]));
  const seedFirst = session.seed.tracks[0] ?? null;
  const orderedIds = uniqueIds([
    ...(seedFirst ? [seedFirst.id] : []),
    ...session.queuedIds,
    ...session.playedIds,
  ]);

  // Ensure horizon by filling from scorer.
  const filled = refillSmartDjSession(session, context, session.constraints.horizon);
  const ids = uniqueIds([
    ...(seedFirst ? [seedFirst.id] : []),
    ...filled.queuedIds,
  ]);

  return ids
    .map((id) => trackMap.get(id))
    .filter((track): track is Track => Boolean(track));
}

export function refillSmartDjSession(
  session: SmartDjSession,
  context: SmartDjContext,
  targetHorizon = session.constraints.horizon,
): SmartDjSession {
  const now = context.now ?? Date.now();
  const blocked = new Set<string>([
    ...session.playedIds,
    ...session.bannedIds,
    ...session.queuedIds,
  ]);
  if (session.seed.tracks[0]) blocked.add(session.seed.tracks[0].id);

  const nextQueued = [...session.queuedIds];
  const recent = recentTracks(session, context);
  while (nextQueued.length < targetHorizon) {
    const candidate = pickNextSmartDjTrack(
      {
        ...session,
        queuedIds: nextQueued,
      },
      context,
      blocked,
      recent,
    );
    if (!candidate) break;
    nextQueued.push(candidate.track.id);
    blocked.add(candidate.track.id);
    recent.push(candidate.track);
    if (recent.length > 8) recent.shift();
  }

  return {
    ...session,
    queuedIds: nextQueued,
    status: nextQueued.length > 0 || session.playedIds.length > 0 ? "playing" : "exhausted",
    updatedAt: now,
  };
}

export function advanceSmartDjSession(
  session: SmartDjSession,
  playedTrackId: string,
  context: SmartDjContext,
): SmartDjSession {
  const playedIds = uniqueIds([...session.playedIds, playedTrackId]);
  const queuedIds = session.queuedIds.filter((id) => id !== playedTrackId);
  const next = refillSmartDjSession(
    {
      ...session,
      playedIds,
      queuedIds,
    },
    context,
    session.constraints.horizon,
  );
  return next;
}

export function banSmartDjTrack(
  session: SmartDjSession,
  trackId: string,
  context: SmartDjContext,
): SmartDjSession {
  const bannedIds = uniqueIds([...session.bannedIds, trackId]);
  const queuedIds = session.queuedIds.filter((id) => id !== trackId);
  return refillSmartDjSession(
    {
      ...session,
      bannedIds,
      queuedIds,
    },
    context,
    session.constraints.horizon,
  );
}

export function pickNextSmartDjTrack(
  session: SmartDjSession,
  context: SmartDjContext,
  blocked: ReadonlySet<string> = new Set([
    ...session.playedIds,
    ...session.bannedIds,
    ...session.queuedIds,
  ]),
  recent: Track[] = recentTracks(session, context),
): SmartDjCandidate | null {
  const candidates = rankSmartDjCandidates(session, context, blocked, recent);
  return candidates[0] ?? null;
}

export function rankSmartDjCandidates(
  session: SmartDjSession,
  context: SmartDjContext,
  blocked: ReadonlySet<string>,
  recent: Track[] = recentTracks(session, context),
): SmartDjCandidate[] {
  const seedTracks = session.seed.tracks;
  if (seedTracks.length === 0) return [];

  const artistCounts = countBy(recent, (track) => normalize(track.artist));
  const albumCounts = countBy(recent, (track) => normalize(track.album));
  const seedArtists = new Set(seedTracks.map((track) => normalize(track.artist)).filter(Boolean));
  const seedAlbums = new Set(seedTracks.map((track) => normalize(track.album)).filter(Boolean));
  const seedGenres = new Set(
    seedTracks.flatMap((track) => (track.genres ?? []).map((genre) => normalize(genre))).filter(Boolean),
  );
  const now = context.now ?? Date.now();

  const scored: SmartDjCandidate[] = [];
  for (const track of context.tracks) {
    if (blocked.has(track.id)) continue;
    const artistKey = normalize(track.artist);
    const albumKey = normalize(track.album);
    if ((artistCounts.get(artistKey) ?? 0) >= session.constraints.maxPerArtist) continue;
    if ((albumCounts.get(albumKey) ?? 0) >= session.constraints.maxPerAlbum) continue;

    const activity = createTrackActivity(context.activity[track.id], now);
    const reasons: string[] = [];
    let score = 0;

    if (seedArtists.has(artistKey) && artistKey) {
      score += 42;
      reasons.push("同艺术家");
    }
    if (seedAlbums.has(albumKey) && albumKey) {
      score += 28;
      reasons.push("同专辑");
    }

    const trackGenres = (track.genres ?? []).map((genre) => normalize(genre)).filter(Boolean);
    const sharedGenres = trackGenres.filter((genre) => seedGenres.has(genre)).length;
    if (sharedGenres > 0) {
      score += Math.min(24, sharedGenres * 12);
      reasons.push("风格接近");
    }

    const seedYears = seedTracks.map((item) => item.year).filter((year): year is number => typeof year === "number");
    if (track.year && seedYears.length > 0) {
      const nearest = seedYears.reduce((best, year) => Math.min(best, Math.abs(year - track.year!)), Number.POSITIVE_INFINITY);
      if (nearest <= 3) {
        score += 10 - nearest * 2;
        reasons.push("年代接近");
      }
    }

    if (session.constraints.preferFavorites && context.favoriteTrackIds.has(track.id)) {
      score += 16;
      reasons.push("收藏加分");
    }

    // Completion affinity and skip penalty from stats.
    const attempts = activity.playCount + activity.skipCount;
    const completeRate = activity.playCount > 0 ? activity.completedCount / Math.max(1, activity.playCount) : 0;
    const skipRate = attempts > 0 ? activity.skipCount / attempts : 0;
    score += completeRate * 14;
    if (session.constraints.avoidHighSkip) {
      score -= skipRate * 30;
      if (skipRate >= 0.5 && activity.skipCount >= 2) continue;
    }

    // Mild rediscovery bias for tracks not heard recently.
    if (activity.lastPlayedAt) {
      const days = Math.max(0, (now - activity.lastPlayedAt) / 86_400_000);
      score += Math.min(12, days / 15);
    } else {
      score += 6;
    }

    // Keep a little novelty away from the exact recent neighborhood.
    const recentArtistHits = recent.filter((item) => normalize(item.artist) === artistKey).length;
    score -= recentArtistHits * 4;

    if (score <= 0 && reasons.length === 0) continue;
    scored.push({ track, score, reasons });
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.track.title.localeCompare(right.track.title, "zh-Hans");
  });
  return scored;
}

export function seedFromTracks(
  kind: SmartDjSeedKind,
  id: string,
  label: string,
  tracks: Track[],
): SmartDjSeed {
  return {
    kind,
    id,
    label,
    tracks: tracks.slice(),
  };
}

function recentTracks(session: SmartDjSession, context: SmartDjContext) {
  const trackMap = new Map(context.tracks.map((track) => [track.id, track]));
  const ids = [...session.playedIds.slice(-5), ...session.queuedIds.slice(0, 3)];
  return ids
    .map((id) => trackMap.get(id))
    .filter((track): track is Track => Boolean(track));
}

function countBy<T>(items: T[], keyOf: (item: T) => string) {
  const map = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

function uniqueIds(ids: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleLowerCase();
}
