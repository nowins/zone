import { usePodcastBrowsePosition } from "../components/BrowsePosition";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Search, Rss } from "lucide-react";
import { MetroLoader } from "../../../components/MetroLoader";
import { Presence } from "../../../motion/presence";
import { MOTION_DURATIONS } from "../../../motion/tokens";
import { filterPodcastSearchHistory } from "../../../utils/podcastDiscovery";
import {
  PODCAST_DISCOVERY_SORTS,
  PODCAST_DISCOVERY_TOPICS,
} from "../constants";
import { DiscoveryShelf, ShowCard } from "../components/ShowCards";
import { EpisodeBrowser } from "../components/EpisodeBrowser";
import {
  PodcastEmpty,
  PodcastLoading,
  PodcastSection,
} from "../components/primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";

export function DiscoverScreen({ vm }: { vm: PodcastViewModel }) {
  const pageRef=usePodcastBrowsePosition("discover");
  const {
    query,
    setQuery,
    searchApple,
    handlePodcastSearchCompositionStart,
    handlePodcastSearchCompositionEnd,
    handlePodcastSearchKeyDown,
    searchState,
    discoveryTopic,
    rssExpanded,
    setRssExpanded,
    rssUrl,
    setRssUrl,
    subscribeRss,
    openingId,
    searchHistory,
    setSearchHistory,
    repeatPodcastSearch,
    browseDiscoveryTopic,
    searchHeading,
    searchResults,
    showPopularDiscovery,
    searchSort,
    setSearchSort,
    sortedSearchResults,
    feeds,
    searchHighlightQuery,
    previewFeed,
    discoveryState,
    discoveryShows,
    discoverySourceLabel,
    discoveryRefreshing,
    loadDiscovery,
  } = vm;
  const searchFieldRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (vm.searchFocusRequest > 0) searchFieldRef.current?.querySelector("input")?.focus();
  }, [vm.searchFocusRequest]);
  const [searchFocused, setSearchFocused] = useState(false);
  const [historyDismissed, setHistoryDismissed] = useState(false);
  const [historyHighlight, setHistoryHighlight] = useState(-1);
  const [genre, setGenre] = useState("");
  const [unfollowedOnly, setUnfollowedOnly] = useState(false);
  const genres = useMemo(() => Array.from(new Set(discoveryShows.flatMap(show => show.genres))).sort(), [discoveryShows]);
  const visibleDiscoveryShows = useMemo(() => discoveryShows.filter(show => (!genre || show.genres.includes(genre)) && (!unfollowedOnly || !feeds.some(feed => feed.feedUrl === show.feedUrl))), [discoveryShows, genre, unfollowedOnly, feeds]);
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

  return (
    <main ref={pageRef} className="podcast-screen podcast-discover-screen">
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

      {rssExpanded ? (
        <div
          id="podcast-rss-subscribe"
          className="podcast-rss-entry"
        >
          <form onSubmit={subscribeRss}>
            <Rss size={15} aria-hidden="true" />
            <input
              value={rssUrl}
              onChange={(event) => setRssUrl(event.target.value)}
              placeholder="粘贴公开 RSS 地址"
              aria-label="RSS 地址"
              autoFocus
            />
            <button
              type="submit"
              disabled={!rssUrl.trim() || Boolean(openingId)}
            >
              关注
            </button>
          </form>
        </div>
      ) : null}

      <div
        className="podcast-discovery-topics"
        role="group"
        aria-label="按主题浏览"
      >
        <span>按主题浏览</span>
        <div>
          {PODCAST_DISCOVERY_TOPICS.map((topic) => (
            <button
              key={topic.id}
              type="button"
              aria-pressed={discoveryTopic === topic.id}
              onClick={() => {
                dismissSearchHistory();
                browseDiscoveryTopic(topic.id);
              }}
            >
              {topic.label}
            </button>
          ))}
        </div>
      </div>

      {searchState !== "idle" ? (
        <>
        <EpisodeBrowser vm={vm} requestedQuery={searchHighlightQuery} />
        <PodcastSection
          title={searchState === "loading" ? "正在搜索" : searchHeading}
          count={searchResults.length}
          actionLabel="返回热门"
          onAction={showPopularDiscovery}
        >
          {searchState === "loading" ? (
            <PodcastLoading label="正在查找节目" />
          ) : searchState === "error" ? (
            <PodcastEmpty label="暂时无法完成搜索" />
          ) : searchResults.length > 0 ? (
            <>
              <div
                className="podcast-search-sorts"
                role="group"
                aria-label="搜索结果排序"
              >
                <span>排序</span>
                <div>
                  {PODCAST_DISCOVERY_SORTS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={searchSort === option.id}
                      onClick={() => setSearchSort(option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="podcast-search-grid">
                {sortedSearchResults.map((result) => (
                  <ShowCard
                    key={result.id}
                    show={result}
                    followed={feeds.some(
                      (feed) => feed.feedUrl === result.feedUrl,
                    )}
                    highlightQuery={searchHighlightQuery}
                    loading={openingId === result.id}
                    onOpen={() => void previewFeed(result, "discover")}
                    showSearchMetadata
                  />
                ))}
              </div>
            </>
          ) : (
            <PodcastEmpty label="没有找到相关节目" />
          )}
        </PodcastSection>
        </>
      ) : (
        <PodcastSection title="热门节目" count={visibleDiscoveryShows.length}>
          <div className="podcast-episode-filters">
            <select aria-label="发现节目分类" value={genre} onChange={event=>setGenre(event.target.value)}><option value="">全部分类</option>{genres.map(value=><option key={value} value={value}>{value}</option>)}</select>
            <label><input type="checkbox" checked={unfollowedOnly} onChange={event=>setUnfollowedOnly(event.target.checked)}/>仅看未关注</label>
          </div>
          <DiscoveryShelf
            state={discoveryState}
            shows={visibleDiscoveryShows}
            sourceLabel={discoverySourceLabel}
            fetchedAt={vm.discoveryFetchedAt}
            refreshing={discoveryRefreshing}
            feeds={feeds}
            openingId={openingId}
            onOpen={(show) => void previewFeed(show, "discover")}
            onRetry={() => void loadDiscovery(true)}
          />
        </PodcastSection>
      )}
    </main>
  );
}
