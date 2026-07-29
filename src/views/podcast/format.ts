import { podcastEpisodePlayedPercent } from "../../utils/podcastListening";
import type { PodcastEpisode } from "../../types";

export function podcastPlayedLabel(episode: PodcastEpisode): string | null {
  const percentage = podcastEpisodePlayedPercent(episode);
  if (percentage === 100) return "已播完";
  if (percentage !== null) return `已播 ${percentage}%`;
  return episode.progressSeconds > 0 ? "收听中" : null;
}

export function podcastDownloadProgressLabel(episode: PodcastEpisode) {
  if (episode.downloadedBytes <= 0) return null;
  if (episode.totalBytes && episode.totalBytes > 0) {
    const percentage = Math.min(
      99,
      Math.floor(episode.downloadedBytes / episode.totalBytes * 100),
    );
    return `${percentage}%`;
  }
  return formatFileSize(episode.downloadedBytes);
}

export function sameStringArray(
  left: readonly string[],
  right: readonly string[],
) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function formatFileSize(bytes: number) {
  const safeBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (safeBytes < 1_024) return `${Math.round(safeBytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = safeBytes / 1_024;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  const formatted = new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: value >= 100 ? 0 : value >= 10 ? 1 : 2,
  }).format(value);
  return `${formatted} ${units[unitIndex]}`;
}

export function formatEpisodeDate(timestamp?: number | null) {
  if (!timestamp || !Number.isFinite(timestamp)) return "日期未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

export function formatEpisodeFullDate(timestamp?: number | null) {
  if (!timestamp || !Number.isFinite(timestamp)) return "发布日期未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(timestamp));
}

export function plainText(value: string) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function shareablePodcastEpisodeUrl(
  episode: PodcastEpisode,
): string | null {
  for (const candidate of [episode.webpageUrl, episode.enclosureUrl]) {
    if (!candidate?.trim()) continue;
    try {
      const parsed = new URL(candidate);
      if (
        (parsed.protocol === "https:" || parsed.protocol === "http:")
        && !parsed.username
        && !parsed.password
      ) {
        return parsed.toString();
      }
    } catch {
      // Ignore malformed feed metadata and try the enclosure fallback.
    }
  }
  return null;
}

export async function copyPodcastShareUrl(url: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      return;
    } catch {
      // Some WebView versions expose Clipboard API without granting access.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = url;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("clipboard unavailable");
    }
  } finally {
    textarea.remove();
  }
}

export function errorMessage(reason: unknown, fallback: string) {
  if (typeof reason === "string" && reason.trim()) return reason;
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  return fallback;
}
