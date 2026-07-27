export function createPodcastProgressWriteGate() {
  const epochs = new Map<string, number>();
  let suppressedEpisodeId: string | null = null;

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
      suppressedEpisodeId = episodeId;
    },
    resume(episodeId: string) {
      if (suppressedEpisodeId !== episodeId) return false;
      suppressedEpisodeId = null;
      advance(episodeId);
      return true;
    },
    isSuppressed(episodeId: string) {
      return suppressedEpisodeId === episodeId;
    },
    allows(episodeId: string, epoch: number) {
      return suppressedEpisodeId !== episodeId
        && (epochs.get(episodeId) ?? 0) === epoch;
    },
  };
}
