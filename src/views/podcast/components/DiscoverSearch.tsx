import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Search, Rss } from "lucide-react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { MetroLoader } from "../../../components/MetroLoader";
import { Presence } from "../../../motion/presence";
import { MOTION_DURATIONS } from "../../../motion/tokens";
import { filterPodcastSearchHistory } from "../../../utils/podcastDiscovery";
import type { PodcastViewModel } from "../usePodcastViewModel";
export function DiscoverSearch({ vm }: { vm: PodcastViewModel }) {
  const { query, setQuery, searchApple, handlePodcastSearchCompositionStart, handlePodcastSearchCompositionEnd, handlePodcastSearchKeyDown, searchState, discoveryTopic, rssExpanded, setRssExpanded, rssUrl, setRssUrl, subscribeRss, openingId, searchHistory, setSearchHistory, repeatPodcastSearch } = vm;
  const searchFieldRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (vm.searchFocusRequest > 0) searchFieldRef.current?.querySelector("input")?.focus();
  }, [vm.searchFocusRequest]);
  const [searchFocused, setSearchFocused] = useState(false);
  const [historyDismissed, setHistoryDismissed] = useState(false);
  const [historyHighlight, setHistoryHighlight] = useState(-1);
  const suggestedHistory = useMemo(
    () => filterPodcastSearchHistory(searchHistory, query),
    [query, searchHistory],
  );
  const showSearchHistory = searchFocused && !historyDismissed && suggestedHistory.length > 0;

  useEffect(() => {
    setHistoryHighlight(-1);
  }, [query, searchFocused, suggestedHistory.length]);

  useEffect(() => {
    if (!showSearchHistory) return;

    function handlePointerDown(event: PointerEvent) {
      const root = searchFieldRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) {
        return;
      }
      setSearchFocused(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [showSearchHistory]);

  function dismissSearchHistory() {
    setHistoryDismissed(true);
    setHistoryHighlight(-1);
  }

  function chooseHistoryTerm(term: string) {
    dismissSearchHistory();
    repeatPodcastSearch(term);
  }

  function isComposingSearchKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    return Boolean(event.nativeEvent.isComposing) || event.nativeEvent.keyCode === 229;
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (isComposingSearchKey(event)) {
      handlePodcastSearchKeyDown(event);
      return;
    }

    if (event.key === "Escape") {
      if (showSearchHistory) {
        event.preventDefault();
        event.stopPropagation();
        dismissSearchHistory();
      }
      handlePodcastSearchKeyDown(event);
      return;
    }

    if (showSearchHistory && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const lastIndex = suggestedHistory.length - 1;
      setHistoryHighlight((current) => {
        if (event.key === "ArrowDown") {
          return current < lastIndex ? current + 1 : 0;
        }
        return current > 0 ? current - 1 : lastIndex;
      });
      return;
    }

    if (
      event.key === "Enter" &&
      showSearchHistory &&
      historyHighlight >= 0 &&
      suggestedHistory[historyHighlight]
    ) {
      event.preventDefault();
      chooseHistoryTerm(suggestedHistory[historyHighlight]);
      return;
    }

    handlePodcastSearchKeyDown(event);
  }

  return <>
      <div className="podcast-discovery-search" ref={searchFieldRef}>
        <div className="podcast-discovery-search-row">
          <div className="podcast-search-field">
            <form
              className="podcast-search-form"
              onSubmit={(event) => {
                dismissSearchHistory();
                searchApple(event);
              }}
            >
              <Search size={17} aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => {
                  setHistoryDismissed(false);
                  setQuery(event.target.value);
                }}
                placeholder="搜索节目、人物或主题…"
                aria-label="搜索播客"
                aria-autocomplete="list"
                aria-controls="podcast-search-history"
                aria-activedescendant={showSearchHistory&&historyHighlight>=0?`podcast-search-history-${historyHighlight}`:undefined}
                aria-expanded={showSearchHistory}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="search"
                onFocus={() => setSearchFocused(true)}
                onCompositionStart={handlePodcastSearchCompositionStart}
                onCompositionEnd={handlePodcastSearchCompositionEnd}
                onKeyDown={handleSearchKeyDown}
              />
              <button
                type="submit"
                disabled={!query.trim()}
              >
                {searchState === "loading" && discoveryTopic === null
                  ? (
                    <span className="podcast-button-loading">
                      <MetroLoader />
                      搜索中
                    </span>
                  )
                  : "搜索"}
              </button>
            </form>
            <Presence show={showSearchHistory} exitDurationMs={MOTION_DURATIONS.micro}>
              <div
                className="podcast-search-history"
                id="podcast-search-history"
                role="listbox"
                aria-label="最近搜索"
              >
                <ul>
                  {suggestedHistory.map((historyQuery, index) => (
                    <li key={historyQuery}>
                      <button
                        type="button"
                        role="option"
                        id={`podcast-search-history-${index}`}
                        aria-selected={historyHighlight === index}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => chooseHistoryTerm(historyQuery)}
                      >
                        {historyQuery}
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="podcast-search-history-clear"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setSearchHistory([]);
                    dismissSearchHistory();
                  }}
                >
                  清空
                </button>
              </div>
            </Presence>
          </div>
          <button
            className="podcast-rss-toggle"
            type="button"
            aria-expanded={rssExpanded}
            aria-controls="podcast-rss-subscribe"
            onClick={() => {
              dismissSearchHistory();
              setRssExpanded((expanded) => !expanded);
            }}
          >
            + RSS
          </button>
        </div>
      </div>

      <Presence show={rssExpanded} exitDurationMs={MOTION_DURATIONS.micro}><Dialog titleId="podcast-rss-title" kicker="添加节目" title="通过 RSS 关注" className="podcast-collection-dialog" busy={Boolean(openingId)} onCancel={() => setRssExpanded(false)} onSubmit={subscribeRss} actions={<><Button disabled={Boolean(openingId)} onClick={() => setRssExpanded(false)}>取消</Button><Button type="submit" variant="primary" busy={Boolean(openingId)} disabled={!rssUrl.trim()}>关注</Button></>}>
        <div
          id="podcast-rss-subscribe"
          className="podcast-rss-entry"
        >
          <div className="podcast-rss-form">
            <Rss size={15} aria-hidden="true" />
            <input
              value={rssUrl}
              onChange={(event) => setRssUrl(event.target.value)}
              placeholder="粘贴公开 RSS 地址"
              aria-label="RSS 地址"
              autoFocus
            />
          </div>
        </div>
        {vm.error && <p role="alert">{vm.error}</p>}
    </Dialog></Presence>
  </>;
}
