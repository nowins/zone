import { COLLECTION_CATEGORY_ORDER, type CollectionHistory, type CollectionLocation } from "../utils/collectionNavigation.js";
import { prepareBrowseTransition, playBrowseTransition } from "./browseTransition.js";

const isIndex = (location: CollectionLocation) => !location.entity && !(location.query.trim() && location.searchMode === "results");

/** Category order supplies sibling direction; object history has a matching return. */
export function collectionPivotDirection(history: CollectionHistory): -1 | 0 | 1 {
  const current = history.entries[history.cursor];
  if (!history.animate) return 0;
  const previous = history.entries[history.cursor - history.direction];
  if (!previous || !isIndex(previous) || !isIndex(current)) return history.direction;
  return COLLECTION_CATEGORY_ORDER.indexOf(current.view) < COLLECTION_CATEGORY_ORDER.indexOf(previous.view) ? -1 : 1;
}

const surfaceKey = (location: CollectionLocation) => JSON.stringify([location.view, location.entity, location.query, location.searchMode, location.playlistId]);

/** Collection supplies history semantics; the shared browser owns all motion. */
export function prepareCollectionPivot(root: HTMLElement, history: CollectionHistory, next: CollectionHistory): void {
  prepareBrowseTransition(root, surfaceKey(history.entries[history.cursor]), surfaceKey(next.entries[next.cursor]), collectionPivotDirection(next) || next.direction, next.animate);
}

export const playCollectionPivot = playBrowseTransition;
