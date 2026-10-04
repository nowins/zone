import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Presence } from "../../../motion/presence";
import { MOTION_DURATIONS } from "../../../motion/tokens";
import { getListeningStats, type ListeningStats as Stats } from "../api";
import { formatTime } from "../../../utils/music";
export function ListeningStats({revision}:{revision:number}) {
  const [stats,setStats]=useState<Stats|null>(null),[open,setOpen]=useState(false),[error,setError]=useState<string|null>(null),[retry,setRetry]=useState(0);
  useEffect(()=>{let disposed=false;void getListeningStats().then(value=>{if(!disposed){setStats(value);setError(null);}}).catch(reason=>{if(!disposed)setError(String(reason));});return()=>{disposed=true;};},[revision,open,retry]);
  return <><div className="podcast-listening-summary">{stats&&<span>近 7 天收听 {formatTime(stats.recentSeconds)} · 累计 {formatTime(stats.totalSeconds)}</span>}<Button variant="ghost" onClick={()=>setOpen(true)}>收听统计</Button></div><Presence show={open} exitDurationMs={MOTION_DURATIONS.micro}><Dialog titleId="podcast-stats-title" kicker="播客" title="收听统计" onCancel={()=>setOpen(false)} onSubmit={event=>event.preventDefault()} actions={<Button onClick={()=>setOpen(false)}>完成</Button>}>
    {error?<p role="alert">{error}<Button onClick={()=>setRetry(value=>value+1)}>重试</Button></p>:stats&&<><p className="podcast-stats-total">{formatTime(stats.totalSeconds)}</p><p>实际收听 · {stats.feedCount} 个节目 · {stats.episodeCount} 集</p><p className="podcast-stats-note">按真实播放时间统计；拖动、标记已听、缓冲和暂停不计入。仅从启用本功能后累计。</p><dl className="podcast-stats-days">{stats.days.map(day=><div key={day.day}><dt>{day.day}</dt><dd>{formatTime(day.seconds)}</dd></div>)}</dl></>}
  </Dialog></Presence></>;
}
