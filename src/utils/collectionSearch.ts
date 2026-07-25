export type CollectionSearchMode = "results" | "browse";

export type CollectionSearchSurface = "library" | "results";

/**
 * Derives which collection body to show: grouped search results, or the
 * normal library browser (including drill-in from a search hit while the
 * query string is still retained in the search field).
 */
export function resolveSearchSurface(
  query: string,
  mode: CollectionSearchMode,
): CollectionSearchSurface {
  return query.trim().length > 0 && mode === "results" ? "results" : "library";
}
