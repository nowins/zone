import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  Download,
  LoaderCircle,
  Play,
  Podcast,
  RefreshCw,
  Search,
} from "lucide-react";
import { formatTime } from "../utils/music";
import type {
  PodcastDownloadResult,
  PodcastEpisode,
  PodcastFeed,
  PodcastProbePlayback,
  PodcastSearchResult,
  PodcastSubscribeResult,
} from "../types";

type RequestState = "idle" | "loading" | "ready" | "error";

export function PodcastProbeView({
  activeEpisodeId,
  isPlaying,
  onPlayDownloaded,
}: {
  activeEpisodeId: string | null;
  isPlaying: boolean;
  onPlayDownloaded: (episode: PodcastProbePlayback) => void;
}) {
  const [query, setQuery] = useState("");
  const [rssUrl, setRssUrl] = useState("");
  const [searchState, setSearchState] = useState<RequestState>("idle");
  const [searchResults, setSearchResults] = useState<PodcastSearchResult[]>([]);
  const [feeds, setFeeds] = useState<PodcastFeed[]>([]);
  const [selectedFeedId, setSelectedFeedId] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>([]);
  const [libraryState, setLibraryState] = useState<RequestState>("loading");
  const [episodeState, setEpisodeState] = useState<RequestState>("idle");
  const [subscribingId, setSubscribingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedFeed = useMemo(
    () => feeds.find((feed) => feed.id === selectedFeedId) ?? null,
    [feeds, selectedFeedId],
  );

  const loadFeeds = useCallback(async (preferredFeedId?: string) => {
    setLibraryState("loading");
    try {
      const nextFeeds = await invoke<PodcastFeed[]>("podcast_list_feeds");
      setFeeds(nextFeeds);
      setSelectedFeedId((current) => {
        if (preferredFeedId && nextFeeds.some((feed) => feed.id === preferredFeedId)) return preferredFeedId;
        if (current && nextFeeds.some((feed) => feed.id === current)) return current;
        return nextFeeds[0]?.id ?? null;
      });
      setLibraryState("ready");
    } catch (reason) {
      setLibraryState("error");
      setError(errorMessage(reason, "读取播客资料库失败"));
    }
  }, []);

  const loadEpisodes = useCallback(async (feedId: string) => {
    setEpisodeState("loading");
    try {
      const nextEpisodes = await invoke<PodcastEpisode[]>("podcast_list_episodes", { feedId });
      setEpisodes(nextEpisodes);
      setEpisodeState("ready");
    } catch (reason) {
      setEpisodes([]);
      setEpisodeState("error");
      setError(errorMessage(reason, "读取单集失败"));
    }
  }, []);

  useEffect(() => {
    void loadFeeds();
  }, [loadFeeds]);

  useEffect(() => {
    if (!selectedFeedId) {
      setEpisodes([]);
      setEpisodeState("idle");
      return;
    }
    void loadEpisodes(selectedFeedId);
  }, [loadEpisodes, selectedFeedId]);

  async function searchApple(event: FormEvent) {
    event.preventDefault();
    const cleanQuery = query.trim();
    if (!cleanQuery || searchState === "loading") return;
    setSearchState("loading");
    setError(null);
    setNotice(null);
    try {
      const results = await invoke<PodcastSearchResult[]>("podcast_search_apple", {
        query: cleanQuery,
        limit: 12,
      });
      setSearchResults(results);
      setSearchState("ready");
    } catch (reason) {
      setSearchResults([]);
      setSearchState("error");
      setError(errorMessage(reason, "搜索节目失败"));
    }
  }

  async function subscribe(
    feedUrl: string,
    hints: { id: string; title?: string; author?: string; artworkUrl?: string | null },
  ) {
    if (!feedUrl || subscribingId) return;
    setSubscribingId(hints.id);
    setError(null);
    setNotice("正在读取节目与单集");
    try {
      const result = await invoke<PodcastSubscribeResult>("podcast_subscribe", {
        feedUrl,
        titleHint: hints.title,
        authorHint: hints.author,
        artworkUrl: hints.artworkUrl ?? undefined,
      });
      setNotice(
        result.insertedCount > 0
          ? `已添加“${result.feed.title}”，新增 ${result.insertedCount} 集`
          : `已刷新“${result.feed.title}”，共 ${result.episodeCount} 集`,
      );
      setRssUrl("");
      await loadFeeds(result.feed.id);
      await loadEpisodes(result.feed.id);
    } catch (reason) {
      setNotice(null);
      setError(errorMessage(reason, "添加节目失败"));
    } finally {
      setSubscribingId(null);
    }
  }

  function subscribeRss(event: FormEvent) {
    event.preventDefault();
    const cleanUrl = rssUrl.trim();
    if (!cleanUrl) return;
    void subscribe(cleanUrl, { id: cleanUrl });
  }

  async function refreshSelectedFeed() {
    if (!selectedFeed || subscribingId) return;
    await subscribe(selectedFeed.feedUrl, {
      id: selectedFeed.id,
      title: selectedFeed.title,
      author: selectedFeed.author ?? undefined,
      artworkUrl: selectedFeed.artworkUrl,
    });
  }

  async function downloadAndPlay(episode: PodcastEpisode) {
    if (downloadingId) return;

    setDownloadingId(episode.id);
    setError(null);
    setNotice(episode.localPath ? `正在准备“${episode.title}”` : `正在下载“${episode.title}”`);
    try {
      const result = await invoke<PodcastDownloadResult>("podcast_download_episode", {
        episodeId: episode.id,
      });
      setEpisodes((current) => current.map((item) =>
        item.id === episode.id
          ? {
              ...item,
              downloadState: "downloaded",
              localPath: result.localPath,
              downloadedBytes: result.downloadedBytes,
            }
          : item,
      ));
      setNotice(result.resumed ? "下载已续传完成，开始播放" : "下载完成，开始播放");
      playEpisode(episode, result.localPath);
    } catch (reason) {
      setNotice(null);
      setEpisodes((current) => current.map((item) =>
        item.id === episode.id ? { ...item, downloadState: "failed" } : item,
      ));
      setError(errorMessage(reason, "下载单集失败"));
    } finally {
      setDownloadingId(null);
    }
  }

  function playEpisode(episode: PodcastEpisode, downloadedPath: string) {
    onPlayDownloaded({
      episodeId: episode.id,
      title: episode.title,
      podcastTitle: selectedFeed?.title ?? "播客",
      downloadedPath,
      artworkUrl: episode.artworkUrl ?? selectedFeed?.artworkUrl,
      savedProgressSeconds: Math.max(0, episode.progressSeconds),
    });
  }

  return (
    <section className="content-band podcast-probe-page">
      <p className="podcast-ghost" aria-hidden="true">podcasts</p>

      <header className="podcast-probe-header">
        <div>
          <span>播客实验</span>
          <h1>从节目开始</h1>
        </div>
        <form className="podcast-rss-form" onSubmit={subscribeRss}>
          <input
            value={rssUrl}
            onChange={(event) => setRssUrl(event.target.value)}
            placeholder="粘贴 RSS 地址"
            aria-label="RSS 地址"
          />
          <button type="submit" disabled={!rssUrl.trim() || Boolean(subscribingId)}>
            添加 RSS
          </button>
        </form>
      </header>

      <div className="podcast-probe-layout">
        <aside className="podcast-discovery">
          <form className="podcast-search-form" onSubmit={searchApple}>
            <Search size={17} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索中文播客…"
              aria-label="搜索播客"
            />
            <button type="submit" disabled={!query.trim() || searchState === "loading"}>
              {searchState === "loading" ? <LoaderCircle className="podcast-spinner" size={17} /> : "搜索"}
            </button>
          </form>

          <div className="podcast-search-results" aria-live="polite">
            {searchState === "idle" ? (
              <div className="podcast-placeholder">
                <Podcast size={28} />
                <span>通过 Apple 中国区查找公开 RSS</span>
              </div>
            ) : searchState === "loading" ? (
              <div className="podcast-placeholder"><span>正在搜索节目</span></div>
            ) : searchResults.length === 0 ? (
              <div className="podcast-placeholder"><span>没有找到节目</span></div>
            ) : (
              searchResults.map((result) => {
                const subscribed = feeds.some((feed) => feed.feedUrl === result.feedUrl);
                return (
                  <article key={result.id} className="podcast-search-result">
                    <PodcastArtwork url={result.artworkUrl} title={result.title} />
                    <div>
                      <strong>{result.title}</strong>
                      <span>{result.author || "未知作者"}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void subscribe(result.feedUrl, result)}
                      disabled={subscribed || Boolean(subscribingId)}
                      title={subscribed ? "已添加" : "添加节目"}
                    >
                      {subscribed ? <Check size={16} /> : subscribingId === result.id ? <LoaderCircle className="podcast-spinner" size={16} /> : "添加"}
                    </button>
                  </article>
                );
              })
            )}
          </div>
        </aside>

        <section className="podcast-library">
          <nav className="podcast-feed-list" aria-label="已添加的播客">
            <div className="podcast-section-heading">
              <span>节目</span>
              <strong>{feeds.length}</strong>
            </div>
            {libraryState === "loading" ? (
              <div className="podcast-placeholder"><span>正在读取节目</span></div>
            ) : feeds.length === 0 ? (
              <div className="podcast-placeholder"><span>还没有添加节目</span></div>
            ) : (
              feeds.map((feed) => (
                <button
                  type="button"
                  key={feed.id}
                  className={feed.id === selectedFeedId ? "active" : ""}
                  onClick={() => setSelectedFeedId(feed.id)}
                >
                  <PodcastArtwork url={feed.artworkUrl} title={feed.title} />
                  <span>
                    <strong>{feed.title}</strong>
                    <small>{feed.author || "未知作者"}</small>
                  </span>
                </button>
              ))
            )}
          </nav>

          <div className="podcast-episode-pane">
            {selectedFeed ? (
              <header className="podcast-episode-header">
                <div>
                  <span>{selectedFeed.author || "播客"}</span>
                  <h2>{selectedFeed.title}</h2>
                </div>
                <button
                  type="button"
                  onClick={() => void refreshSelectedFeed()}
                  disabled={Boolean(subscribingId)}
                  title="刷新节目"
                >
                  <RefreshCw size={16} />
                  刷新
                </button>
              </header>
            ) : null}

            <div className="podcast-episode-list">
              {episodeState === "loading" ? (
                <div className="podcast-placeholder"><span>正在读取单集</span></div>
              ) : selectedFeed && episodes.length === 0 ? (
                <div className="podcast-placeholder"><span>这个节目还没有单集</span></div>
              ) : (
                episodes.map((episode) => {
                  const isActive = activeEpisodeId === episode.id;
                  const isDownloading = downloadingId === episode.id;
                  return (
                    <article key={episode.id} className={`podcast-episode${isActive ? " active" : ""}`}>
                      <div className="podcast-episode-date">
                        <span>{formatEpisodeDate(episode.publishedAt)}</span>
                        <small>{episode.durationSeconds ? formatTime(episode.durationSeconds) : "时长未知"}</small>
                      </div>
                      <div className="podcast-episode-copy">
                        <strong>{episode.title}</strong>
                        {episode.description ? <p>{plainText(episode.description)}</p> : null}
                        {episode.progressSeconds > 0 ? (
                          <small>{episode.completed ? "已播放" : `已播放至 ${formatTime(episode.progressSeconds)}`}</small>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="podcast-episode-action"
                        onClick={() => void downloadAndPlay(episode)}
                        disabled={Boolean(downloadingId)}
                        title={episode.localPath ? "播放单集" : "下载并播放"}
                      >
                        {isDownloading ? (
                          <LoaderCircle className="podcast-spinner" size={18} />
                        ) : isActive && isPlaying ? (
                          <span className="podcast-playing-mark">正在播放</span>
                        ) : episode.localPath ? (
                          <Play size={18} fill="currentColor" />
                        ) : (
                          <Download size={18} />
                        )}
                      </button>
                    </article>
                  );
                })
              )}
            </div>
          </div>
        </section>
      </div>

      {(notice || error) ? (
        <div className={`podcast-probe-notice${error ? " error" : ""}`} role={error ? "alert" : "status"}>
          {error ?? notice}
        </div>
      ) : null}
    </section>
  );
}

function PodcastArtwork({ url, title }: { url?: string | null; title: string }) {
  return (
    <div className="podcast-artwork">
      {url ? (
        <img src={url} alt="" draggable={false} referrerPolicy="no-referrer" />
      ) : (
        <span>{title.trim().slice(0, 1) || "播"}</span>
      )}
    </div>
  );
}

function formatEpisodeDate(timestamp?: number | null) {
  if (!timestamp || !Number.isFinite(timestamp)) return "日期未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function plainText(value: string) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function errorMessage(reason: unknown, fallback: string) {
  if (typeof reason === "string" && reason.trim()) return reason;
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  return fallback;
}
