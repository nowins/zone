import type { AppPage } from "../types";

export function AppHeader({
  page,
  onNavigate,
  disabled = false,
}: {
  page: Exclude<AppPage, "nowPlaying">;
  onNavigate: (page: "quickplay" | "collection" | "podcasts" | "settings", animate?: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <header className="app-header">
      <div className="app-identity">
        <strong className="brand">ZONE</strong>
        <nav className="primary-pivot" aria-label="主要导航">
          <button
            disabled={disabled}
            className={page === "quickplay" ? "active" : ""}
            aria-current={page === "quickplay" ? "page" : undefined}
            onClick={() => onNavigate("quickplay")}
          >
            quickplay
          </button>
          <button
            disabled={disabled}
            className={page === "collection" ? "active" : ""}
            aria-current={page === "collection" ? "page" : undefined}
            onClick={() => onNavigate("collection")}
          >
            收藏
          </button>
          <button
            disabled={disabled}
            className={page === "podcasts" ? "active" : ""}
            aria-current={page === "podcasts" ? "page" : undefined}
            onClick={() => onNavigate("podcasts")}
          >
            播客
          </button>
        </nav>
      </div>
    </header>
  );
}
