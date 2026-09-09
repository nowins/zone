import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bookmark, Heart, ListMusic, Pause, Play, Repeat, Repeat1, RotateCcw, RotateCw, Search, Shuffle, SkipBack, SkipForward } from "lucide-react";
import { Button } from "../components/Button";
import { Cover } from "../components/Cover";
import { MetroLoader } from "../components/MetroLoader";
import { PlaybackProgress } from "../components/PlaybackProgress";
import { VolumeControl } from "../components/TransportControls";
import { useCollectionPanelMotion } from "../hooks/useCollectionPivot";
import type { CollectionIndex } from "../utils/collectionEntities";
import { formatTime } from "../utils/music";
import { podcastArtworkSrc } from "../utils/podcastArtwork";
import { resolvePlaylistTracks } from "../utils/smartPlaylist";
import type { AppPage, Playlist, PodcastPlayback, PodcastPlaybackStatus, PodcastQueueItem, RepeatMode, Track, TrackActivityMap } from "../types";

type Screen = "now" | "music" | "queue";
type Category = "albums" | "artists" | "tracks" | "playlists";
type Detail = { kind: "albums" | "artists" | "playlists"; id: string };
const screens: [Screen, string][] = [["now", "正在播放"], ["music", "音乐"], ["queue", "队列"]];
const categories: [Category, string][] = [["albums", "专辑"], ["artists", "艺术家"], ["tracks", "歌曲"], ["playlists", "列表"]];

type Props = {
  index: CollectionIndex;
  playlists: Playlist[];
  activity: TrackActivityMap;
  favoriteTrackIds: ReadonlySet<string>;
  track: Track | null;
  queueIds: string[];
  episode: PodcastPlayback | null;
  podcastQueue: PodcastQueueItem[];
  podcastStatus: PodcastPlaybackStatus;
  playbackRate: number;
  isPlaying: boolean;
  ready: boolean;
  progress: number;
  duration: number;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  onPlay: (track: Track, tracks?: Track[]) => void;
  onPlayTracks: (tracks: Track[]) => void;
  onToggleFavorite: (track: Track) => void;
  onPlayPause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeek: (seconds: number) => void;
  onVolume: (value: number) => void;
  onShuffle: () => void;
  onRepeat: () => void;
  onPlaybackRate: (value: number) => void;
  onToggleSaved: () => void;
  onPlayEpisode: (id: string) => void;
  onRetryPodcast: () => void;
  onOpenNormal: (page?: AppPage) => void;
};

export function CompactPlayerView(props: Props) {
  const { index, playlists, activity, favoriteTrackIds, track, episode, podcastQueue, podcastStatus, isPlaying, ready } = props;
  const [screen, setScreen] = useState<Screen>(episode || track ? "now" : "music");
  const [category, setCategory] = useState<Category>("albums");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [query, setQuery] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const animate = useRef(false);
  const restoreFocus = useRef<string | null>(null);
  const title = episode?.title || track?.title || "尚未播放";
  const available = ready && Boolean(episode || track);
  const favorite = episode ? Boolean(episode.saved) : Boolean(track && favoriteTrackIds.has(track.id));
  const busy = Boolean(episode && ["loading", "buffering"].includes(podcastStatus));
  const playlistEntries = useMemo(() => playlists.map(playlist => ({
    id: playlist.id, title: playlist.name,
    tracks: resolvePlaylistTracks(playlist, index.tracks, { favoriteTrackIds, activity }).tracks,
  })), [playlists, index, favoriteTrackIds, activity]);
  const queueTracks = useMemo(() => props.queueIds.flatMap(id => index.trackById.get(id) ?? []), [props.queueIds, index]);
  const groups = useMemo(() => category === "albums" ? index.albums.map(album => ({ id: album.key, title: album.album, subtitle: album.artist, tracks: album.tracks, art: album.coverPath }))
    : category === "artists" ? index.artists.map(artist => ({ id: artist.artist, title: artist.artist, subtitle: `${artist.albums.length} 张专辑`, tracks: artist.tracks, art: artist.imagePath || artist.tracks.find(item => item.cover_path)?.cover_path }))
    : playlistEntries.map(playlist => ({ ...playlist, subtitle: `${playlist.tracks.length} 首歌曲`, art: playlist.tracks.find(item => item.cover_path)?.cover_path })), [category, index, playlistEntries]);
  const selected = detail ? groups.find(group => group.id === detail.id) : null;
  const needle = query.trim().toLocaleLowerCase();
  const matches = (...values: string[]) => values.join(" ").toLocaleLowerCase().includes(needle);
  const visibleTracks = useMemo(() => (detail ? selected?.tracks ?? [] : index.tracks)
    .filter(item => [item.title, item.artist, item.album].join(" ").toLocaleLowerCase().includes(needle)), [detail, selected, index, needle]);
  const revision = `${screen}:${category}:${detail?.id ?? ""}`;
  useCollectionPanelMotion(contentRef, revision, undefined, animate.current);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    content.scrollTop = 0;
    const focusKey = restoreFocus.current;
    if (focusKey !== null) {
      restoreFocus.current = null;
      const target = [...content.querySelectorAll<HTMLElement>("[data-compact-item]")].find(node => node.dataset.compactItem === focusKey);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest" });
    } else if (detail) content.querySelector<HTMLElement>(".compact-back")?.focus({ preventScroll: true });
    if (screen === "queue") content.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [revision]);

  function navigate(next: Screen, keyboard = false) {
    animate.current = !keyboard;
    setScreen(next);
  }
  function goBack() {
    if (detail) { restoreFocus.current = detail.id; setDetail(null); setQuery(""); }
  }
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[aria-modal="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        animate.current = false;
        setScreen("music");
        setCategory("tracks");
        setDetail(null);
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (event.key === "Escape") {
        event.preventDefault();
        animate.current = false;
        if (query) setQuery("");
        else if (detail) goBack();
        else if (screen !== "now") {
          setScreen("now");
          document.getElementById("compact-tab-now")?.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [query, detail, screen]);

  function play(item: Track, source: Track[]) {
    props.onPlay(item, source);
  }
  function trackRows(items: Track[], source = items) {
    return <div className="compact-track-list">{items.map((item, i) => <div className="compact-track-row" key={item.id}>
      <Button variant="ghost" className="compact-track" disabled={!ready} onClick={() => play(item, source)}
        title={`${item.title} · ${item.artist}`} aria-current={!episode && item.id === track?.id ? "true" : undefined}>
        <span className="compact-track-number">{!episode && item.id === track?.id ? <Play size={12} fill="currentColor" /> : i + 1}</span>
        <span className="compact-row-copy"><strong>{item.title}</strong><small>{item.artist}</small></span>
        <span className="compact-track-time">{item.duration_seconds ? formatTime(item.duration_seconds) : ""}</span>
      </Button>
      <Button variant="ghost" className="compact-favorite" title={favoriteTrackIds.has(item.id) ? "取消收藏" : "收藏"}
        aria-label={`${favoriteTrackIds.has(item.id) ? "取消收藏" : "收藏"}：${item.title}`} aria-pressed={favoriteTrackIds.has(item.id)}
        onClick={() => props.onToggleFavorite(item)}><Heart size={14} fill={favoriteTrackIds.has(item.id) ? "currentColor" : "none"} /></Button>
    </div>)}</div>;
  }

  return <main className="compact-player" aria-label="小屏播放器">
    <nav className="compact-tabs" aria-label="小屏导航" role="tablist">
      {screens.map(([value, label], i) => <button key={value} id={`compact-tab-${value}`} role="tab"
        aria-selected={screen === value} aria-controls="compact-content" tabIndex={screen === value ? 0 : -1}
        onClick={event => navigate(value, event.detail === 0)}
        onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (i + 1) % screens.length : event.key === "ArrowLeft" ? (i + screens.length - 1) % screens.length
            : event.key === "Home" ? 0 : event.key === "End" ? screens.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault();
          navigate(screens[next][0], true);
          document.getElementById(`compact-tab-${screens[next][0]}`)?.focus();
        }}>{label}</button>)}
    </nav>

    <div ref={contentRef} className="compact-content" id="compact-content" role="tabpanel" aria-labelledby={`compact-tab-${screen}`} tabIndex={-1}>
      {screen === "now" ? available ? <section className="compact-now">
        <div className="compact-artist" title={episode?.podcastTitle || track?.artist}>{episode?.podcastTitle || track?.artist}</div>
        <div className="compact-album" title={episode ? "播客" : track?.album}>{episode ? "播客" : track?.album}</div>
        <Cover className="compact-artwork" artPath={episode ? undefined : track?.cover_path}
          src={episode ? podcastArtworkSrc(episode.artworkUrl || episode.feedArtworkUrl) : undefined} label={title} />
        <div className="compact-song-heading"><h1 title={title}>{title}</h1>
          <Button variant="ghost" className="compact-favorite" disabled={!available} aria-pressed={favorite}
            title={episode ? favorite ? "移出稍后听" : "稍后听" : favorite ? "取消收藏" : "收藏"}
            onClick={() => { if (episode) props.onToggleSaved(); else if (track) props.onToggleFavorite(track); }}>
            {episode ? <Bookmark size={20} fill={favorite ? "currentColor" : "none"} /> : <Heart size={20} fill={favorite ? "currentColor" : "none"} />}
          </Button></div>
      </section> : <div className="compact-empty"><ListMusic size={34} strokeWidth={1} /><h1>听点音乐</h1>
        <Button variant="ghost" onClick={() => navigate("music")}>浏览音乐</Button></div> : null}

      {screen === "music" ? <section className="compact-library">
        <div className="compact-categories" aria-label="音乐分类">{categories.map(([value, label]) => <Button variant="ghost" key={value}
          aria-pressed={category === value} onClick={event => { animate.current = event.detail !== 0; setCategory(value); setDetail(null); setQuery(""); }}>{label}</Button>)}</div>
        <label className="compact-search"><Search size={14} aria-hidden="true" /><input ref={searchRef} value={query}
          onChange={event => setQuery(event.target.value)} aria-label="搜索音乐" placeholder="搜索音乐" /></label>
        {detail ? <div className="compact-detail-heading"><Button variant="ghost" className="compact-back" icon={<ArrowLeft size={16} />}
          onClick={event => { animate.current = event.detail !== 0; goBack(); }}>返回</Button>
          <h2>{selected?.title ?? "内容已不存在"}</h2></div> : null}
        {category === "tracks" || detail ? <>
          <div className="compact-list-heading"><span>{visibleTracks.length} 首歌曲</span>
            <Button variant="ghost" size="sm" icon={<Play size={12} />} disabled={!ready || !visibleTracks.length}
              onClick={() => props.onPlayTracks(visibleTracks)}>播放全部</Button></div>
          {trackRows(visibleTracks)}
          {!visibleTracks.length ? <p className="compact-empty-label">{needle ? "没有匹配的歌曲" : "暂无歌曲"}</p> : null}
        </> : <div className={category === "albums" ? "compact-albums" : "compact-groups"}>
          {groups.filter(group => matches(group.title, group.subtitle)).map(group => <Button variant="ghost" className="compact-group" key={group.id}
            data-compact-item={group.id} title={group.title} onClick={event => { animate.current = event.detail !== 0; setDetail({ kind: category as Detail["kind"], id: group.id }); setQuery(""); }}>
            <Cover artPath={group.art} label={group.title} className="compact-group-art" />
            <span className="compact-row-copy"><strong>{group.title}</strong><small>{group.subtitle}</small></span>
          </Button>)}
          {!groups.some(group => matches(group.title, group.subtitle)) ? <p className="compact-empty-label">{needle ? "没有匹配的音乐" : "暂无音乐"}</p> : null}
        </div>}
        {!index.tracks.length ? <Button variant="ghost" onClick={() => props.onOpenNormal("settings")}>在正常模式添加音乐</Button> : null}
      </section> : null}

      {screen === "queue" ? <section className="compact-queue">
        <div className="compact-list-heading"><span>{episode ? "播客待播" : `${queueTracks.length} 首歌曲`}</span>
          <Button variant="ghost" size="sm" onClick={() => props.onOpenNormal(episode ? "podcasts" : "collection")}>管理</Button></div>
        {episode ? <>
          <Button variant="ghost" className="compact-episode" aria-current="true" onClick={() => navigate("now")}>
            <span className="compact-row-copy"><strong>{episode.title}</strong><small>正在播放 · {episode.podcastTitle}</small></span></Button>
          {podcastQueue.filter(item => item.episode.id !== episode.episodeId).map(({ episode: item }) => <Button variant="ghost" className="compact-episode" key={item.id}
            onClick={() => props.onPlayEpisode(item.id)}><span className="compact-row-copy"><strong>{item.title}</strong><small>{item.feedTitle}</small></span></Button>)}
          {!podcastQueue.some(item => item.episode.id !== episode.episodeId) ? <p className="compact-empty-label">没有待播单集</p> : null}
        </> : <>{trackRows(queueTracks, queueTracks)}{!queueTracks.length ? <p className="compact-empty-label">队列为空</p> : null}
          {podcastQueue.length ? <><div className="compact-list-heading"><span>播客待播</span></div>{podcastQueue.map(({ episode: item }) => <Button variant="ghost" className="compact-episode" key={item.id}
            onClick={() => props.onPlayEpisode(item.id)}><span className="compact-row-copy"><strong>{item.title}</strong><small>{item.feedTitle}</small></span></Button>)}</> : null}</>}
      </section> : null}
    </div>

    <footer className={`compact-footer${screen === "now" ? " is-now" : ""}`}>
      {episode && podcastStatus === "error" ? <div className="compact-playback-status" role="alert"><span>播放失败</span><Button variant="ghost" size="sm" onClick={props.onRetryPodcast}>重试</Button></div>
        : busy ? <div className="compact-playback-status" role="status"><MetroLoader size={12} /><span>{podcastStatus === "loading" ? "正在加载" : "正在缓冲"}</span></div> : null}
      <PlaybackProgress label={title} progress={props.progress} duration={props.duration} disabled={!available || props.duration <= 0}
        onSeek={props.onSeek} onLabelClick={() => navigate("now")} />
      <div className="compact-transport">
        {episode ? <Button variant="ghost" className="compact-rate" title="播放速度" aria-label="播放速度" onClick={() => props.onPlaybackRate(props.playbackRate >= 2 ? 1 : props.playbackRate + 0.25)}>{props.playbackRate}×</Button>
          : <Button variant="ghost" title="随机播放" aria-pressed={props.shuffle} disabled={!available} onClick={props.onShuffle}><Shuffle size={17} /></Button>}
        <Button variant="ghost" title={episode ? "后退 15 秒" : "上一首"} disabled={!available}
          onClick={episode ? () => props.onSeek(Math.max(0, props.progress - 15)) : props.onPrevious}>{episode ? <RotateCcw size={21} /> : <SkipBack size={22} fill="currentColor" />}</Button>
        <Button variant="ghost" className="compact-play" title={isPlaying ? "暂停" : "播放"} disabled={!available} onClick={props.onPlayPause}>
          {isPlaying ? <Pause size={25} fill="currentColor" /> : <Play size={25} fill="currentColor" />}</Button>
        <Button variant="ghost" title={episode ? "前进 30 秒" : "下一首"} disabled={!available || Boolean(episode && props.duration <= 0)}
          onClick={episode ? () => props.onSeek(Math.min(props.duration, props.progress + 30)) : props.onNext}>{episode ? <RotateCw size={21} /> : <SkipForward size={22} fill="currentColor" />}</Button>
        {episode ? <Button variant="ghost" title="下一集" disabled={!podcastQueue.some(item => item.episode.id !== episode.episodeId)} onClick={props.onNext}><SkipForward size={17} /></Button>
          : <Button variant="ghost" title={props.repeat === "one" ? "单曲循环" : props.repeat === "all" ? "列表循环" : "关闭循环"}
            aria-pressed={props.repeat !== "off"} disabled={!available} onClick={props.onRepeat}>{props.repeat === "one" ? <Repeat1 size={17} /> : <Repeat size={17} />}</Button>}
      </div>
      <VolumeControl volume={props.volume} onVolume={props.onVolume} />
    </footer>
  </main>;
}
