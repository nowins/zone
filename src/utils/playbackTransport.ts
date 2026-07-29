export type PlayAttemptToken = { sourceKey: string | null; attempt: number };

export function isCurrentPlayAttempt(
  token: PlayAttemptToken,
  currentAttempt: number,
  currentSourceKey: string | null,
): boolean {
  return token.attempt === currentAttempt && token.sourceKey === currentSourceKey;
}

export function resolvePodcastStartPosition(
  requestedStart: { episodeId: string; position: number } | null,
  episodeId: string,
  savedProgressSeconds: number,
): { position: number; explicit: boolean } {
  const explicit = requestedStart?.episodeId === episodeId;
  return {
    position: explicit ? requestedStart!.position : savedProgressSeconds,
    explicit,
  };
}

export function resolvePodcastResumePosition(
  pending: { position: number; explicit?: boolean },
  episode: { completed: boolean },
  mediaDuration: number,
): number {
  if (pending.explicit) {
    return Math.min(pending.position, mediaDuration || pending.position);
  }
  if (episode.completed || pending.position <= 0) return 0;
  if (mediaDuration > 0 && pending.position >= Math.max(0, mediaDuration - 5)) {
    return 0;
  }
  return Math.min(pending.position, mediaDuration || pending.position);
}

export function shouldConsumePendingQueueEpisode(
  pending: string | null,
  activeEpisodeId: string | null,
  audioEpisodeId: string | null,
  episodeId: string,
): boolean {
  return (
    pending === episodeId
    && activeEpisodeId === episodeId
    && audioEpisodeId === episodeId
  );
}

export function podcastStatusForPause(intent: boolean): "loading" | "paused" {
  return intent ? "loading" : "paused";
}

export function podcastStatusForWaiting(intent: boolean): "buffering" | "paused" {
  return intent ? "buffering" : "paused";
}

export function podcastStatusForCanPlay(
  intent: boolean,
  paused: boolean,
): "paused" | "loading" | "playing" {
  if (!intent) return "paused";
  return paused ? "loading" : "playing";
}
