import { normalizePodcastSearchHistory } from "../../utils/podcastDiscovery";
import type { PodcastLibrarySort } from "../../utils/podcastLibrary";
import {
  PODCAST_DISCOVERY_STORAGE_KEY,
  PODCAST_LIBRARY_STORAGE_KEY,
} from "./constants";

export function readPodcastLibraryPreferences(): {
  sort: PodcastLibrarySort;
  customOrder: string[];
} {
  try {
    const raw = localStorage.getItem(PODCAST_LIBRARY_STORAGE_KEY);
    if (!raw) return { sort: "recent", customOrder: [] };
    const parsed = JSON.parse(raw) as {
      sort?: unknown;
      customOrder?: unknown;
    };
    const sort = parsed.sort === "name" || parsed.sort === "custom"
      ? parsed.sort
      : "recent";
    const customOrder = Array.isArray(parsed.customOrder)
      ? parsed.customOrder.filter(
        (feedId): feedId is string =>
          typeof feedId === "string" && Boolean(feedId),
      )
      : [];
    return { sort, customOrder };
  } catch {
    return { sort: "recent", customOrder: [] };
  }
}

export function readPodcastSearchHistory() {
  try {
    const raw = localStorage.getItem(PODCAST_DISCOVERY_STORAGE_KEY);
    if (!raw) return normalizePodcastSearchHistory([]);
    const parsed = JSON.parse(raw) as { searchHistory?: unknown };
    return normalizePodcastSearchHistory(parsed?.searchHistory);
  } catch {
    return normalizePodcastSearchHistory([]);
  }
}

export function writePodcastSearchHistory(searchHistory: string[]) {
  try {
    const raw = localStorage.getItem(PODCAST_DISCOVERY_STORAGE_KEY);
    let current: Record<string, unknown> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      } catch {
        current = {};
      }
    }
    localStorage.setItem(
      PODCAST_DISCOVERY_STORAGE_KEY,
      JSON.stringify({
        ...current,
        searchHistory: normalizePodcastSearchHistory(searchHistory),
      }),
    );
  } catch {
    // Search history remains available for the current session.
  }
}
