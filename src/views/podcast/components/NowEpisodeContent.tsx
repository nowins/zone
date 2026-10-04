import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { getEpisodeDetail, getEpisodeChapters, cancelPodcastRequest } from "../api";
import type { PodcastChapterDocument, PodcastEpisodeDetail, PodcastPlayback } from "../../../types";
import { formatTime } from "../../../utils/music";
import { findActivePodcastChapterIndex } from "../../../utils/podcastChapters";
import { PodcastNotes } from "./Notes";
import { TranscriptPanel } from "./TranscriptPanel";
import { EpisodeBookmarks } from "./Bookmarks";
import { PodcastLoading } from "./primitives";

type Reading = "notes" | "show" | "chapters" | "transcript" | "bookmarks";

export function NowEpisodeContent({ episode, progress, initialReading = "notes", onSeek, onMore, onClose }: {
  episode: PodcastPlayback;
  progress: number;
  initialReading?: "notes" | "show";
  onSeek: (seconds: number) => void;
  onMore: () => void;
  onClose: () => void;
}) {
  const [reading, setReading] = useState<Reading>(initialReading);
  const [visited, setVisited] = useState<ReadonlySet<Reading>>(() => new Set([initialReading]));
  const [detail, setDetail] = useState<PodcastEpisodeDetail | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [chapters, setChapters] = useState<PodcastChapterDocument | null>(null);
  const [chapterError, setChapterError] = useState(false);
  const [chapterRevision, setChapterRevision] = useState(0);
  const navRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { navRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, []);
  useEffect(() => { changeReading(initialReading); }, [initialReading]);
  function changeReading(value: Reading) {
    setReading(value);
    setVisited(current => new Set([...current, value]));
  }
  useEffect(() => {
    let disposed = false;
    setError(false);
    void getEpisodeDetail(episode.episodeId).then(value => { if (!disposed) setDetail(value); })
      .catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; };
  }, [episode.episodeId, revision]);
  useEffect(() => {
    if (reading !== "chapters" || chapters) return;
    let disposed = false;
    setChapterError(false);
    void getEpisodeChapters(episode.episodeId).then(value => { if (!disposed) setChapters(value); })
      .catch(() => { if (!disposed) setChapterError(true); });
    return () => { disposed = true; void cancelPodcastRequest("chapters").catch(() => {}); };
  }, [episode.episodeId, reading, chapters, chapterRevision]);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [reading]);
  const labels: [Reading, string][] = [["notes", "简介"], ["show", "节目"],
    ...(detail?.hasChapters ? [["chapters", "章节"] as [Reading, string]] : []),
    ["transcript", "转写"], ["bookmarks", "书签"]];
  const currentChapter = chapters ? findActivePodcastChapterIndex(chapters.chapters, progress) : -1;
  return <section id="podcast-now-content" className="podcast-now-content" aria-label="本集内容">
    <nav ref={navRef} className="podcast-now-reading-nav" aria-label="本集阅读内容">
      {labels.map(([id, label]) => <Button key={id} variant="ghost" aria-pressed={reading === id}
        onClick={() => changeReading(id)}>{label}</Button>)}
      <Button variant="ghost" className="podcast-now-content-close" onClick={onClose}>收起</Button>
    </nav>
    <div ref={scrollRef} className="podcast-now-reading-body" tabIndex={0} aria-label="本集阅读区">
      {reading === "notes" && (episode.description
        ? <PodcastNotes source={episode.description} base={episode.webpageUrl ?? detail?.feed.feedUrl}
          duration={episode.durationSeconds} onPlayAt={onSeek} /> : <p>这集暂时没有简介。</p>)}
      {reading === "show" && (detail ? <>
        {detail.feed.author && <p className="podcast-now-show-author">{detail.feed.author}</p>}
        {detail.feed.description ? <PodcastNotes source={detail.feed.description} base={detail.feed.feedUrl} /> : <p>这个节目暂时没有简介。</p>}
        <Button variant="ghost" onClick={onMore}>更多单集与操作</Button>
      </> : error ? <p role="alert">节目资料读取失败 <Button onClick={() => setRevision(value => value + 1)}>重试</Button></p>
        : <PodcastLoading label="正在读取节目资料" />)}
      {reading === "chapters" && (chapters ? <>
        {chapters.stale && <p>显示上次成功读取的章节</p>}
        <ol className="podcast-chapter-list">{chapters.chapters.map((chapter, index) => <li key={index}>
          <Button variant="ghost" aria-current={index === currentChapter ? "true" : undefined} onClick={() => onSeek(chapter.startSeconds)}><time>{formatTime(chapter.startSeconds)}</time><span>{chapter.title}</span></Button>
        </li>)}</ol>
      </> : chapterError ? <p role="alert">章节读取失败 <Button onClick={() => setChapterRevision(value => value + 1)}>重试</Button></p>
        : <PodcastLoading label="正在读取章节" />)}
      {visited.has("transcript") && <div hidden={reading !== "transcript"}><TranscriptPanel episodeId={episode.episodeId} active={reading === "transcript"} progress={progress} revealed onPlayAt={onSeek} /></div>}
      {visited.has("bookmarks") && <div hidden={reading !== "bookmarks"}><EpisodeBookmarks episode={episode} position={progress} onPlayAt={onSeek} /></div>}
      {error && reading === "notes" && <p role="status">补充资料暂时无法读取 <Button variant="ghost" onClick={() => setRevision(value => value + 1)}>重试</Button></p>}
    </div>
  </section>;
}
