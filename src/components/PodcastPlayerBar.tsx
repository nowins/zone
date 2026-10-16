import { BookmarkPlus, Clock, ListMusic, Pause, Play, Podcast, RotateCcw, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { PodcastTransportOptions } from "./PodcastTransportOptions";
import { PodcastRateButton } from "./PodcastRateButton";
import { Presence } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";
import { PlaybackProgress } from "./PlaybackProgress";
import { VolumeControl } from "./TransportControls";
import type { PodcastPlayback, PodcastPlaybackStatus, PodcastSleepTimer } from "../types";
import { podcastArtworkSrc } from "../utils/podcastArtwork";
import { formatTime } from "../utils/music";

export function PodcastPlayerBar({
  episode,
  isPlaying,
  progress,
  duration,
  volume,
  status,
  onPlayPause,
  onRetry,
  onSeek,
  onVolume,
  onOpenPodcasts,
  onOpenNowPlaying,
  backwardSeconds = 15,
  forwardSeconds = 30,
  playbackRate = 1, sleepTimer = null, queueCount = 0, rateScope = "default", onPlaybackRate, onSleepTimer, onOpenQueue, onRecordMoment,
}: {
  episode: PodcastPlayback;
  isPlaying: boolean;
  progress: number;
  duration: number;
  volume: number;
  status: PodcastPlaybackStatus;
  onPlayPause: () => void;
  onRetry: () => void;
  onSeek: (value: number) => void;
  onVolume: (value: number) => void;
  onOpenPodcasts: () => void;
  onOpenNowPlaying: () => void;
  backwardSeconds?: number;
  forwardSeconds?: number;
  playbackRate?: number; sleepTimer?: PodcastSleepTimer; queueCount?: number;
  rateScope?: "default" | "show";
  onRecordMoment?: () => void;
  onPlaybackRate?: (value: number) => void; onSleepTimer?: (value: PodcastSleepTimer) => void; onOpenQueue?: () => void;
}) {
  const artworkSrc = podcastArtworkSrc(episode.artworkUrl);
  const [optionsOpen,setOptionsOpen]=useState(false),[now,setNow]=useState(Date.now());
  useEffect(()=>{setOptionsOpen(false);},[episode.episodeId]);
  useEffect(()=>{if(sleepTimer?.kind!=="deadline")return;setNow(Date.now());const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer);},[sleepTimer]);
  const sleepLabel=sleepTimer?.kind==="episodeEnd"?"本集结束":sleepTimer?.kind==="deadline"?`${Math.max(0,Math.ceil((sleepTimer.deadlineAt-now)/60000))} 分钟`:"睡眠关闭";
  const stateLabel=status==="loading"?"正在连接":status==="buffering"?"正在缓冲":status==="error"?"播放失败":isPlaying?"正在播放":"已暂停";
  return (
    <footer className="player podcast-player">
      <nav className="player-shortcuts" aria-label="播客快捷方式">
        <button onClick={onOpenPodcasts} title="返回播客" aria-label="返回播客">
          <Podcast size={19} />
        </button>
        {onPlaybackRate && <PodcastRateButton value={playbackRate} onChange={onPlaybackRate} scope={rateScope} label="底栏播放速度" />}
        {onPlaybackRate && onSleepTimer && <button className="podcast-bar-options-trigger" onClick={()=>setOptionsOpen(true)} aria-label={`睡眠定时，${sleepLabel}`} aria-haspopup="dialog" title={`睡眠定时 · ${sleepLabel}`}><Clock size={15}/>{sleepTimer&&<span className="podcast-bar-countdown">{sleepTimer.kind === "episodeEnd" ? "本集结束" : formatTime(Math.max(0, Math.ceil((sleepTimer.deadlineAt-now)/1000)))}</span>}</button>}
        {onOpenQueue&&<button onClick={onOpenQueue} aria-label={`打开待播，${queueCount} 集`} title={`待播 ${queueCount} 集`}><ListMusic size={18}/><small>{queueCount||""}</small></button>}
        {onRecordMoment && <button onClick={onRecordMoment} aria-label="记录此刻" title="记录此刻"><BookmarkPlus size={18}/></button>}
        <span className="podcast-bar-status" role="status" title={stateLabel}>{status==="loading"||status==="buffering"||status==="error"?stateLabel:episode.playbackLocalPath?"离线":episode.localPath?"已下载":""}</span>
      </nav>

      <div className="player-primary">
        <button className="player-cover podcast-player-cover" data-now-playing-trigger="cover" onClick={onOpenNowPlaying} title="打开正在播放">
          {artworkSrc ? (
            <img src={artworkSrc} alt="" draggable={false} />
          ) : (
            <span aria-hidden="true"><Podcast size={22} /></span>
          )}
        </button>
        <PlaybackProgress
          mediaKey={episode.episodeId}
          label={`${episode.title} · ${episode.podcastTitle}`}
          progress={progress}
          duration={duration}
          onLabelClick={onOpenNowPlaying}
          onSeek={onSeek}
        />
      </div>

      <div className="player-transport">
        <div className="zune-controls podcast-controls">
          <button onClick={() => onSeek(Math.max(0, progress - backwardSeconds))} title={`后退 ${backwardSeconds} 秒`} aria-label={`后退 ${backwardSeconds} 秒`}>
            <RotateCcw size={16} />
            <span>{backwardSeconds}</span>
          </button>
          <button
            className="zune-play"
            onClick={status === "error" ? onRetry : onPlayPause}
            title={status === "error" ? "重试播放" : isPlaying ? "暂停" : "播放"}
          >
            {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </button>
          <button onClick={() => onSeek(Math.min(duration || progress + forwardSeconds, progress + forwardSeconds))} title={`前进 ${forwardSeconds} 秒`} aria-label={`前进 ${forwardSeconds} 秒`}>
            <RotateCw size={16} />
            <span>{forwardSeconds}</span>
          </button>
        </div>
        <VolumeControl volume={volume} onVolume={onVolume} />
      </div>
      <Presence show={optionsOpen} exitDurationMs={MOTION_DURATIONS.micro}>{onPlaybackRate&&onSleepTimer?<PodcastTransportOptions rate={playbackRate} timer={sleepTimer} rateScope={rateScope} episodeId={episode.episodeId} onRate={onPlaybackRate} onTimer={onSleepTimer} onClose={()=>setOptionsOpen(false)}/>:<span style={{display:"none"}}/>}</Presence>
    </footer>
  );
}
