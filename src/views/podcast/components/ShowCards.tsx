import { Check } from "lucide-react";
import { Button } from "../../../components/Button";
import { MetroLoader } from "../../../components/MetroLoader";
import { splitPodcastSearchMatch } from "../../../utils/podcastDiscovery";
import type { PodcastDiscoveryShow, PodcastFeed } from "../../../types";
import type { RequestState, ShowCandidate } from "../types";
import { formatEpisodeDate } from "../format";
import {
  PodcastArtwork,
  PodcastEmpty,
  PodcastLoading,
} from "./primitives";

function DiscoveryShelf({
  state,
  shows,
  sourceLabel,
  refreshing,
  feeds,
  openingId,
  onOpen,
  onRetry,
}: {
  state: RequestState;
  shows: PodcastDiscoveryShow[];
  sourceLabel: string;
  refreshing: boolean;
  feeds: PodcastFeed[];
  openingId: string | null;
  onOpen: (show: PodcastDiscoveryShow) => void;
  onRetry: () => void;
}) {
  if (state === "idle" || state === "loading") {
    return <PodcastLoading label="正在读取热门节目" />;
  }
  if (state === "error") {
    return (
      <div className="podcast-inline-state">
        <span>热门节目暂时不可用，资料库和搜索仍可使用</span>
        <Button variant="ghost" size="sm" onClick={onRetry}>重试</Button>
      </div>
    );
  }
  if (shows.length === 0) {
    return <PodcastEmpty label="暂时没有热门节目" />;
  }
  return (
    <>
    <div className="podcast-discovery-source">
      <span>{sourceLabel}</span>
      <Button variant="ghost" size="sm" busy={refreshing} onClick={onRetry}>
        {refreshing ? "刷新中" : "刷新榜单"}
      </Button>
    </div>
    <div className="podcast-show-shelf">
      {shows.map((show) => (
        <ShowCard
          key={show.id}
          show={show}
          followed={feeds.some((feed) => feed.feedUrl === show.feedUrl)}
          loading={openingId === show.id}
          onOpen={() => onOpen(show)}
        />
      ))}
    </div>
    </>
  );
}

function ShowCard({
  show,
  followed,
  highlightQuery = "",
  loading,
  onOpen,
  showSearchMetadata = false,
}: {
  show: ShowCandidate & {
    episodeCount?: number | null;
    genres?: string[];
    latestReleaseAt?: number | null;
    rank?: number;
  };
  followed: boolean;
  highlightQuery?: string;
  loading: boolean;
  onOpen: () => void;
  showSearchMetadata?: boolean;
}) {
  const genres = show.genres?.filter(Boolean).slice(0, showSearchMetadata ? 2 : 1)
    ?? [];
  const episodeCount = typeof show.episodeCount === "number"
    && Number.isFinite(show.episodeCount)
    ? Math.max(0, Math.floor(show.episodeCount))
    : null;
  return (
    <button
      type="button"
      className="podcast-show-card"
      onClick={onOpen}
      disabled={loading}
    >
      <PodcastArtwork url={show.artworkUrl} title={show.title} />
      <span className="podcast-show-card-copy">
        <strong>
          <PodcastSearchHighlight
            text={show.title}
            query={highlightQuery}
          />
        </strong>
        <small>
          <PodcastSearchHighlight
            text={show.author || "未知作者"}
            query={highlightQuery}
          />
        </small>
        {showSearchMetadata ? (
          <>
            {episodeCount !== null || show.latestReleaseAt ? (
              <span className="podcast-show-card-meta">
                {episodeCount !== null ? <span>{episodeCount} 集</span> : null}
                {show.latestReleaseAt ? (
                  <span>更新 {formatEpisodeDate(show.latestReleaseAt)}</span>
                ) : null}
              </span>
            ) : null}
            {genres.length > 0 ? (
              <span className="podcast-show-card-genres">
                {genres.map((genre, index) => (
                  <em key={`${index}-${genre}`}>{genre}</em>
                ))}
              </span>
            ) : null}
          </>
        ) : genres[0] ? (
          <em>{genres[0]}</em>
        ) : null}
      </span>
      {loading ? (
        <MetroLoader className="podcast-card-state" />
      ) : followed ? (
        <Check className="podcast-card-state" size={16} />
      ) : show.rank ? (
        <span className="podcast-card-rank">{show.rank}</span>
      ) : null}
    </button>
  );
}

function PodcastSearchHighlight({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  return (
    <>
      {splitPodcastSearchMatch(text, query).map((segment, index) =>
        segment.matched ? (
          <mark key={`${index}-${segment.text}`}>{segment.text}</mark>
        ) : (
          <span key={`${index}-${segment.text}`}>{segment.text}</span>
        )
      )}
    </>
  );
}

export { DiscoveryShelf, PodcastSearchHighlight, ShowCard };
