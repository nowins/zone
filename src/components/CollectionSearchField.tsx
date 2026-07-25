import { forwardRef } from "react";
import { Search, X } from "lucide-react";

export const CollectionSearchField = forwardRef<
  HTMLInputElement,
  {
    query: string;
    onQuery: (value: string) => void;
    onClear: () => void;
    showReturnToResults: boolean;
    onReturnToResults: () => void;
    resultsId?: string;
  }
>(function CollectionSearchField(
  {
    query,
    onQuery,
    onClear,
    showReturnToResults,
    onReturnToResults,
    resultsId = "collection-search-results",
  },
  ref,
) {
  const hasQuery = query.trim().length > 0;

  return (
    <div className={`collection-search${hasQuery ? " has-query" : ""}`}>
      {showReturnToResults ? (
        <button
          type="button"
          className="collection-search-return"
          onClick={onReturnToResults}
        >
          返回结果
        </button>
      ) : null}
      <label className="collection-search-field">
        <Search size={14} strokeWidth={1.6} aria-hidden="true" />
        <input
          id="collection-search-input"
          ref={ref}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="搜索音乐、艺术家、专辑…"
          aria-label="搜索音乐"
          aria-controls={hasQuery ? resultsId : undefined}
          aria-autocomplete="none"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        {hasQuery ? (
          <button
            type="button"
            className="collection-search-clear"
            onClick={onClear}
            title="清除搜索"
            aria-label="清除搜索"
          >
            <X size={13} aria-hidden="true" />
          </button>
        ) : null}
      </label>
    </div>
  );
});
