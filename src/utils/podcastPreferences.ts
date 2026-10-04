export type PodcastPreferences = {
  autoDownloadCount: number; cleanupPlayed: boolean; storageLimitMb: number;
  playbackRate: number | null; introSeconds: number; outroSeconds: number;
  backwardSeconds: number; forwardSeconds: number; oldestFirst: boolean;
  normalizeVoice: boolean; trimSilence: boolean; inheritPlayback: boolean;
  notifyNewEpisodes?: boolean | null;
};
export const DEFAULT_PODCAST_PREFERENCES: PodcastPreferences = {
  autoDownloadCount: 0, cleanupPlayed: false, storageLimitMb: 0, playbackRate: null,
  introSeconds: 0, outroSeconds: 0, backwardSeconds: 15, forwardSeconds: 30, oldestFirst: false,
  normalizeVoice: false, trimSilence: false, inheritPlayback: true,
};
export function effectivePodcastPreferences(global: Partial<PodcastPreferences>|null|undefined, feed: Partial<PodcastPreferences>|null|undefined) {
  const defaults={...DEFAULT_PODCAST_PREFERENCES,...global};
  return feed?.inheritPlayback === false ? {...defaults,...feed,playbackRate:feed.playbackRate ?? defaults.playbackRate} : defaults;
}
export function podcastIntroPosition(position: number, duration: number, intro: number, outro: number, explicit: boolean) {
  if(explicit || duration <= intro+outro+1 || intro <= 0)return position;
  return Math.max(position,intro);
}
export function podcastOutroReached(position: number, duration: number, intro: number, outro: number) {
  return Number.isFinite(duration) && duration > intro+outro+1 && outro > 0 && position >= duration-outro;
}
