import type { AppPage } from "../types";

export function AppHeader({
  page,
  onNavigate,
}: {
  page: Exclude<AppPage, "nowPlaying">;
  onNavigate: (page: "quickplay" | "collection" | "podcasts" | "settings", animate?: boolean) => void;
}) {
  return (
    <header className="app-header">
      <div className="app-identity">
        <strong className="brand">ZONE</strong>
        <nav className="primary-pivot" aria-label="主要导航">
          <button
            className={page === "quickplay" ? "active" : ""}
            onClick={event => onNavigate("quickplay", event.detail > 0)}
          >
            quickplay
          </button>
          <button
            className={page === "collection" ? "active" : ""}
            onClick={event => onNavigate("collection", event.detail > 0)}
          >
            收藏
          </button>
          <button
            className={page === "podcasts" ? "active" : ""}
            onClick={event => onNavigate("podcasts", event.detail > 0)}
          >
            播客
          </button>
        </nav>
      </div>
    </header>
  );
}
