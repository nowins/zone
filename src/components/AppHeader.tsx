import { Search, X } from "lucide-react";
import type { AppPage } from "../types";

export function AppHeader({
  page,
  query,
  onQuery,
  onNavigate,
}: {
  page: Exclude<AppPage, "nowPlaying">;
  query: string;
  onQuery: (value: string) => void;
  onNavigate: (page: "quickplay" | "collection" | "settings") => void;
}) {
  return (
    <header className="app-header">
      <div className="app-identity">
        <strong className="brand">ZONE</strong>
        <nav className="primary-pivot" aria-label="主要导航">
          <button
            className={page === "quickplay" ? "active" : ""}
            onClick={() => onNavigate("quickplay")}
          >
            quickplay
          </button>
          <button
            className={page === "collection" ? "active" : ""}
            onClick={() => onNavigate("collection")}
          >
            收藏
          </button>
        </nav>
      </div>

      <div className="app-utilities">
        {page === "collection" ? (
          <label className="search-box" data-active={query.trim().length > 0}>
            <input
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  onQuery("");
                  event.currentTarget.blur();
                }
              }}
              placeholder="搜索"
              aria-label="搜索音乐"
              aria-controls="collection-search-results"
              aria-expanded={query.trim().length > 0}
            />
            {query.trim() ? (
              <button
                type="button"
                className="search-clear"
                onClick={() => onQuery("")}
                aria-label="清除搜索"
                title="清除搜索"
              >
                <X size={14} aria-hidden="true" />
              </button>
            ) : (
              <Search size={15} aria-hidden="true" />
            )}
          </label>
        ) : null}
      </div>
    </header>
  );
}
