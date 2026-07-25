import type { AppPage } from "../types";

export function AppHeader({
  page,
  onNavigate,
}: {
  page: Exclude<AppPage, "nowPlaying">;
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
    </header>
  );
}
