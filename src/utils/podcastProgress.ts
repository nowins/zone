export function createPodcastProgressWriteGate() {
  const epochs = new Map<string, number>();
  const suppressedEpisodeIds = new Set<string>();

  function advance(episodeId: string) {
    const nextEpoch = (epochs.get(episodeId) ?? 0) + 1;
    epochs.set(episodeId, nextEpoch);
    return nextEpoch;
  }

  return {
    capture(episodeId: string) {
      return epochs.get(episodeId) ?? 0;
    },
    suppress(episodeId: string) {
      advance(episodeId);
      suppressedEpisodeIds.add(episodeId);
    },
    resume(episodeId: string) {
      if (!suppressedEpisodeIds.delete(episodeId)) return false;
      advance(episodeId);
      return true;
    },
    isSuppressed(episodeId: string) {
      return suppressedEpisodeIds.has(episodeId);
    },
    allows(episodeId: string, epoch: number) {
      return !suppressedEpisodeIds.has(episodeId)
        && (epochs.get(episodeId) ?? 0) === epoch;
    },
  };
}
