import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Search, Settings2, Square, X } from "lucide-react";

export function Titlebar({
  isSettings,
  onOpenSettings,
  searchActive,
  onOpenSearch,
  query,
  onQuery,
}: {
  isSettings: boolean;
  onOpenSettings: () => void;
  searchActive: boolean;
  onOpenSearch: () => void;
  query: string;
  onQuery: (value: string) => void;
}) {
  const appWindow = getCurrentWindow();
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const hasQuery = query.trim().length > 0;
  const searchExpanded = searchActive && searchOpen;

  function openSearch() {
    onOpenSearch();
    setSearchOpen(true);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }

  function collapseSearch() {
    setSearchOpen(false);
    searchInputRef.current?.blur();
  }

  function closeSearch() {
    onQuery("");
    collapseSearch();
  }

  useEffect(() => {
    if (!searchActive) setSearchOpen(false);
  }, [searchActive]);

  useEffect(() => {
    function handleSearchShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        onOpenSearch();
        setSearchOpen(true);
        window.requestAnimationFrame(() => searchInputRef.current?.focus());
        return;
      }

      if (event.key === "Escape" && (searchOpen || hasQuery)) {
        event.preventDefault();
        onQuery("");
        setSearchOpen(false);
        searchInputRef.current?.blur();
      }
    }

    window.addEventListener("keydown", handleSearchShortcut, true);
    return () => window.removeEventListener("keydown", handleSearchShortcut, true);
  }, [hasQuery, onOpenSearch, onQuery, searchOpen]);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div data-tauri-drag-region />
      <div className="window-controls">
        <div
          className={`titlebar-search${searchExpanded ? " expanded" : ""}${hasQuery ? " has-query" : ""}`}
          onPointerLeave={collapseSearch}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) collapseSearch();
          }}
        >
          <button
            type="button"
            className="titlebar-search-trigger"
            onClick={openSearch}
            title="搜索"
            aria-label="搜索"
            aria-expanded={searchExpanded}
            aria-controls="collection-search-input"
          >
            <Search size={13} strokeWidth={1.6} aria-hidden="true" />
          </button>
          <input
            id="collection-search-input"
            ref={searchInputRef}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeSearch();
            }}
            placeholder="搜索音乐、艺术家、专辑…"
            aria-label="搜索音乐"
            aria-controls="collection-search-results"
            aria-autocomplete="none"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            tabIndex={searchExpanded ? 0 : -1}
          />
          <button
            type="button"
            className="titlebar-search-close"
            onClick={closeSearch}
            title="关闭搜索"
            aria-label="关闭搜索"
            tabIndex={searchExpanded ? 0 : -1}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
        <button
          className={isSettings ? "titlebar-settings active" : "titlebar-settings"}
          onClick={onOpenSettings}
          title="设置"
          aria-current={isSettings ? "page" : undefined}
        >
          <Settings2 size={13} aria-hidden="true" />
          <span>设置</span>
        </button>
        <button onClick={() => appWindow.minimize()} title="最小化">
          <Minus size={15} />
        </button>
        <button onClick={() => appWindow.toggleMaximize()} title="最大化">
          <Square size={12} />
        </button>
        <button onClick={() => appWindow.close()} title="关闭">
          <X size={15} />
        </button>
      </div>
    </header>
  );
}
