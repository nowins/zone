import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ArrowLeft, Bookmark, Heart, ListMusic, MoreHorizontal, Pause, Play, Repeat, Repeat1, RotateCcw, RotateCw, Search, Shuffle, SkipBack, SkipForward } from "lucide-react";
import { Button } from "../components/Button";
import { Cover } from "../components/Cover";
import { MetroLoader } from "../components/MetroLoader";
import { PlaybackProgress } from "../components/PlaybackProgress";
import { VolumeControl } from "../components/TransportControls";
import { useCollectionPanelMotion } from "../hooks/useCollectionPivot";
import { Presence } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";
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
  const [controlsOpen, setControlsOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionsRef = useRef<HTMLDivElement | null>(null);
  const mountOptions = useCallback((element: HTMLDivElement | null) => {
    optionsRef.current = element;
    element?.querySelector<HTMLElement>("input")?.focus({ preventScroll: true });
  }, []);
  const gesture = useRef<{ id: number; x: number; y: number; horizontal: boolean } | null>(null);
  const suppressClick = useRef(false);
  const animate = useRef(false);
  const restoreFocus = useRef<string | null>(null);
  const focusScreen = useRef(false);
  const title = episode?.title || track?.title || "尚未播放";
  const available = ready && Boolean(episode || track);
  const focusedNow = screen === "now" && available;
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
  const previousPanel = useRef({ screen, detail, revision });
  const goingBack = screens.findIndex(([value]) => value === screen) < screens.findIndex(([value]) => value === previousPanel.current.screen)
    || (screen === previousPanel.current.screen && previousPanel.current.detail !== null && detail === null);
  const motionOrder = goingBack ? [revision, previousPanel.current.revision] : [previousPanel.current.revision, revision];
  useCollectionPanelMotion(contentRef, revision, motionOrder, animate.current);
  useLayoutEffect(() => { previousPanel.current = { screen, detail, revision }; }, [screen, detail, revision]);

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
    } else if (focusScreen.current) {
      focusScreen.current = false;
      (document.getElementById(`compact-tab-${screen}`) ?? content).focus({ preventScroll: true });
    } else if (detail) content.querySelector<HTMLElement>(".compact-back")?.focus({ preventScroll: true });
    if (screen === "queue") content.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [revision]);

  function navigate(next: Screen, keyboard = false) {
    animate.current = !keyboard;
    focusScreen.current = next !== screen;
    setControlsOpen(false);
    setScreen(next);
  }
  function goBack() {
    if (detail) { restoreFocus.current = detail.id; setDetail(null); setQuery(""); }
  }
  function closeControls() {
    setControlsOpen(false);
    if (optionsRef.current?.contains(document.activeElement)) document.getElementById("compact-options-toggle")?.focus();
  }
  useLayoutEffect(() => {
    optionsRef.current?.toggleAttribute("inert", !controlsOpen);
    if (controlsOpen) optionsRef.current?.querySelector<HTMLElement>("input")?.focus({ preventScroll: true });
  }, [controlsOpen]);
  useEffect(() => {
    if (!controlsOpen) return;
    function onOutside(event: Event) {
      if (event.target instanceof Element && !optionsRef.current?.contains(event.target) && !document.getElementById("compact-options-toggle")?.contains(event.target)) closeControls();
    }
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("focusin", onOutside);
    return () => {
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("focusin", onOutside);
    };
  }, [controlsOpen]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[aria-modal="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        animate.current = false;
        setScreen("music");
        setCategory("tracks");
        setDetail(null);
        setControlsOpen(false);
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (event.key === "Escape") {
        event.preventDefault();
        animate.current = false;
        if (controlsOpen) { closeControls(); document.getElementById("compact-options-toggle")?.focus(); }
        else if (query) setQuery("");
        else if (detail) goBack();
        else if (screen !== "now") navigate("now", true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [query, detail, screen, controlsOpen]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    suppressClick.current = false;
    if (!event.isPrimary || event.button !== 0 || (event.target as Element).closest("input, textarea, [contenteditable]")) return;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, horizontal: false };
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = gesture.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = Math.abs(event.clientX - start.x), dy = Math.abs(event.clientY - start.y);
    if (!start.horizontal && dy > 12 && dy > dx) { gesture.current = null; suppressClick.current = true; return; }
    if (!start.horizontal && dx > 12 && dx > dy * 1.5) {
      start.horizontal = true;
      suppressClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = gesture.current;
    gesture.current = null;
    if (!start || start.id !== event.pointerId || !start.horizontal) return;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(event.clientY - start.y) * 1.5) return;
    animate.current = true;
    if (screen === "music" && detail && dx > 0) goBack();
    else {
      const next = screens.findIndex(([value]) => value === screen) + (dx < 0 ? 1 : -1);
      if (screens[next]) navigate(screens[next][0]);
    }
  }

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

  return <main className={`compact-player${focusedNow ? " is-focused" : ""}`} aria-label="小屏播放器">
    {!focusedNow ? <nav className="compact-tabs" aria-label="小屏导航" role="tablist">
      {screens.map(([value, label], i) => <button key={value} id={`compact-tab-${value}`} role="tab"
        aria-label={label} aria-selected={screen === value} aria-controls="compact-content" tabIndex={screen === value ? 0 : -1}
        onClick={event => navigate(value, event.detail === 0)}
        onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (i + 1) % screens.length : event.key === "ArrowLeft" ? (i + screens.length - 1) % screens.length
            : event.key === "Home" ? 0 : event.key === "End" ? screens.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault();
          navigate(screens[next][0], true);
        }}>{value === "now" ? "播放" : label}</button>)}
    </nav> : null}

    <div ref={contentRef} className="compact-content" id="compact-content" role={focusedNow ? "region" : "tabpanel"}
      aria-label={focusedNow ? "正在播放" : undefined} aria-labelledby={focusedNow ? undefined : `compact-tab-${screen}`} tabIndex={-1}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerCancel={() => { gesture.current = null; }} onLostPointerCapture={() => { gesture.current = null; }}
      onClickCapture={event => { if (suppressClick.current && event.detail > 0) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}
      onDragStart={event => event.preventDefault()}>
      {screen === "now" ? available ? <section className="compact-now">
        <Cover className="compact-artwork" artPath={episode ? undefined : track?.cover_path}
          src={episode ? podcastArtworkSrc(episode.artworkUrl || episode.feedArtworkUrl) : undefined} label={title} />
        <div className="compact-song-heading"><h1 title={title}>{title}</h1></div>
        <div className="compact-artist" title={episode?.podcastTitle || track?.artist}>{episode?.podcastTitle || track?.artist}</div>
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
      <Presence show={controlsOpen} exitDurationMs={MOTION_DURATIONS.micro}>
        <div ref={mountOptions}
          id="compact-options" className="compact-options" role="group" aria-label="播放选项" aria-hidden={!controlsOpen}>
          <VolumeControl volume={props.volume} onVolume={props.onVolume} />
          <div className="compact-options-actions">
            <Button variant="ghost" disabled={!available} aria-pressed={favorite}
              title={episode ? favorite ? "移出稍后听" : "稍后听" : favorite ? "取消收藏" : "收藏"}
              icon={episode ? <Bookmark size={14} fill={favorite ? "currentColor" : "none"} /> : <Heart size={14} fill={favorite ? "currentColor" : "none"} />}
              onClick={() => { if (episode) props.onToggleSaved(); else if (track) props.onToggleFavorite(track); }}>
              {episode ? "稍后听" : "收藏"}</Button>
            {episode ? <>
              <Button variant="ghost" title="播放速度" aria-label="播放速度" onClick={() => props.onPlaybackRate(props.playbackRate >= 2 ? 1 : props.playbackRate + 0.25)}>{props.playbackRate}×</Button>
              <Button variant="ghost" icon={<SkipForward size={14} />} disabled={!podcastQueue.some(item => item.episode.id !== episode.episodeId)} onClick={props.onNext}>下一集</Button>
            </> : <>
              <Button variant="ghost" title="随机播放" icon={<Shuffle size={14} />} aria-pressed={props.shuffle} disabled={!available} onClick={props.onShuffle}>随机</Button>
              <Button variant="ghost" title={props.repeat === "one" ? "单曲循环" : props.repeat === "all" ? "列表循环" : "关闭循环"}
                icon={props.repeat === "one" ? <Repeat1 size={14} /> : <Repeat size={14} />} aria-pressed={props.repeat !== "off"} disabled={!available} onClick={props.onRepeat}>
                {props.repeat === "one" ? "单曲" : props.repeat === "all" ? "列表" : "循环"}</Button>
            </>}
          </div>
          <div className="compact-options-navigation" aria-label="浏览">
            <Button variant="ghost" onClick={event => navigate("music", event.detail === 0)}>音乐</Button>
            <Button variant="ghost" onClick={event => navigate("queue", event.detail === 0)}>队列</Button>
          </div>
        </div>
      </Presence>
      {episode && podcastStatus === "error" ? <div className="compact-playback-status" role="alert"><span>播放失败</span><Button variant="ghost" size="sm" onClick={props.onRetryPodcast}>重试</Button></div>
        : busy ? <div className="compact-playback-status" role="status"><MetroLoader size={12} /><span>{podcastStatus === "loading" ? "正在加载" : "正在缓冲"}</span></div> : null}
      <PlaybackProgress label={title} progress={props.progress} duration={props.duration} disabled={!available || props.duration <= 0}
        onSeek={props.onSeek} onLabelClick={() => navigate("now")} />
      <div className="compact-transport">
        <Button variant="ghost" title={episode ? "后退 15 秒" : "上一首"} disabled={!available}
          onClick={episode ? () => props.onSeek(Math.max(0, props.progress - 15)) : props.onPrevious}>{episode ? <RotateCcw size={20} /> : <SkipBack size={20} fill="currentColor" />}</Button>
        <Button variant="ghost" className="compact-play" title={isPlaying ? "暂停" : "播放"} disabled={!available} onClick={props.onPlayPause}>
          {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</Button>
        <Button variant="ghost" title={episode ? "前进 30 秒" : "下一首"} disabled={!available || Boolean(episode && props.duration <= 0)}
          onClick={episode ? () => props.onSeek(Math.min(props.duration, props.progress + 30)) : props.onNext}>{episode ? <RotateCw size={20} /> : <SkipForward size={20} fill="currentColor" />}</Button>
        <Button id="compact-options-toggle" variant="ghost" title="更多播放选项" aria-expanded={controlsOpen} aria-controls="compact-options"
          onClick={() => setControlsOpen(value => !value)}><MoreHorizontal size={18} /></Button>
      </div>
    </footer>
  </main>;
}
