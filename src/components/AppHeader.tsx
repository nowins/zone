import { Search } from "lucide-react";
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
          <label className="search-box">
            <input
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder="搜索"
              aria-label="搜索音乐"
            />
            <Search size={17} aria-hidden="true" />
          </label>
        ) : null}
        <button
          className={page === "settings" ? "utility-active" : ""}
          onClick={() => onNavigate("settings")}
        >
          设置
        </button>
      </div>
    </header>
  );
}
