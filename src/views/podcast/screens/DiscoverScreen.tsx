import { useMemo, useState } from "react";
import { usePodcastBrowsePosition } from "../components/BrowsePosition";
import { PODCAST_DISCOVERY_SORTS } from "../constants";
import { DiscoveryShelf, ShowCard } from "../components/ShowCards";
import { EpisodeBrowser } from "../components/EpisodeBrowser";
import { PodcastEmpty, PodcastLoading, PodcastSection } from "../components/primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";
export function DiscoverScreen({ vm }: { vm: PodcastViewModel }) {
  const pageRef = usePodcastBrowsePosition("discover");
  const { searchState, searchHeading, searchResults, showPopularDiscovery, searchSort, setSearchSort, sortedSearchResults, feeds, searchHighlightQuery, previewFeed, discoveryState, discoveryShows, discoverySourceLabel, discoveryRefreshing, loadDiscovery, openingId } = vm;
  const [genre, setGenre] = useState("");
  const [unfollowedOnly, setUnfollowedOnly] = useState(false);
  const genres = useMemo(() => Array.from(new Set(discoveryShows.flatMap(show => show.genres))).sort(), [discoveryShows]);
  const visibleDiscoveryShows = useMemo(() => discoveryShows.filter(show => (!genre || show.genres.includes(genre)) && (!unfollowedOnly || !feeds.some(feed => feed.feedUrl === show.feedUrl))), [discoveryShows, genre, unfollowedOnly, feeds]);
  return <main ref={pageRef} className="podcast-screen podcast-discover-screen">
    {searchState === "idle" && <div className="podcast-discovery-filters">
      <div className="podcast-discovery-genres" role="group" aria-label="发现节目分类">
        {["", ...genres].map(value => <button key={value} type="button" aria-pressed={genre === value} onClick={() => setGenre(value)}>{value || "全部分类"}</button>)}
      </div>
      <button className="podcast-discovery-follow-filter" type="button" aria-pressed={unfollowedOnly} onClick={() => setUnfollowedOnly(value => !value)}>仅看未关注</button>
    </div>}
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
    </main>;
}
