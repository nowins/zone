import type { PodcastChapter } from "../types.js";

export function findActivePodcastChapterIndex(
  chapters: PodcastChapter[],
  progressSeconds: number,
): number {
  if (!Number.isFinite(progressSeconds) || progressSeconds < 0) return -1;
  for (let index = chapters.length - 1; index >= 0; index -= 1) {
    const chapter = chapters[index];
    if (
      !Number.isFinite(chapter.startSeconds)
      || chapter.startSeconds < 0
      || progressSeconds < chapter.startSeconds
    ) {
      continue;
    }
    const explicitEnd = chapter.endSeconds;
    const end = Number.isFinite(explicitEnd)
      && (explicitEnd ?? 0) > chapter.startSeconds
      ? explicitEnd as number
      : chapters[index + 1]?.startSeconds ?? Number.POSITIVE_INFINITY;
    if (progressSeconds < end) return index;
  }
  return -1;
}
