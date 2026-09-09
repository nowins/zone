import type { AppPage, ViewMode } from "../types";
import { collectionEntityKey, type CollectionEntityRef } from "./collectionEntities.js";

export type CollectionSearchFilter = "all" | "artists" | "albums" | "songs" | "playlists";
export type CollectionScrollPosition = { top: number; left: number; anchor?: string; offset?: number };
export type CollectionSurface = {
  focus?: string;
  scrolls: Record<string, CollectionScrollPosition>;
  selections: Record<string, string>;
};
export type CollectionLocation = {
  entity: CollectionEntityRef | null;
  view: ViewMode;
  query: string;
  searchMode: "browse" | "results";
  filter: CollectionSearchFilter;
  tab: "overview" | "albums" | "songs";
  playlistId: string;
  surface: CollectionSurface;
  origin?: { page: Exclude<AppPage, "collection">; focus?: string; scrolls?: { top: number; left: number }[] };
};
export type CollectionHistory = { entries: CollectionLocation[]; cursor: number; revision: number; direction: 1 | -1 };
export const emptyCollectionSurface = (): CollectionSurface => ({ scrolls: {}, selections: {} });
export const initialCollectionLocation = (): CollectionLocation => ({ entity: null, view: "artists", query: "",
  searchMode: "results", filter: "all", tab: "overview", playlistId: "favorites", surface: emptyCollectionSurface() });
export const initialCollectionHistory = (): CollectionHistory => ({ entries: [initialCollectionLocation()], cursor: 0, revision: 0, direction: 1 });
export function locationKey(location: CollectionLocation): string {
  if (location.query.trim() && location.searchMode === "results") return `search:${location.query}`;
  return location.entity ? collectionEntityKey(location.entity) : `index:${location.view}:${location.view === "playlists" ? location.playlistId : ""}`;
}
export function pushCollectionLocation(history: CollectionHistory, next: CollectionLocation, outgoing: CollectionSurface): CollectionHistory {
  const current = history.entries[history.cursor];
  if (!next.origin && locationKey(current) === locationKey(next)) return history;
  const entries = [...history.entries.slice(0, history.cursor), { ...current, surface: outgoing }, next].slice(-60);
  return { entries, cursor: entries.length - 1, revision: history.revision + 1, direction: 1 };
}
export function travelCollectionHistory(history: CollectionHistory, delta: 1 | -1, outgoing: CollectionSurface): CollectionHistory {
  const cursor = history.cursor + delta;
  if (cursor < 0 || cursor >= history.entries.length) return history;
  return { entries: history.entries.map((entry, index) => index === history.cursor ? { ...entry, surface: outgoing } : entry),
    cursor, revision: history.revision + 1, direction: delta };
}
