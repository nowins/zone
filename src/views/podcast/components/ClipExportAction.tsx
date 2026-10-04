import { useState } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Presence } from "../../../motion/presence";
import { MOTION_DURATIONS } from "../../../motion/tokens";
import { exportPodcastClip } from "../api";
import { formatTime } from "../../../utils/music";
import type { PodcastEpisode } from "../../../types";
export function ClipExportAction({episode,position}:{episode:PodcastEpisode;position:number}) {
  const [open,setOpen]=useState(false),[start,setStart]=useState(0),[end,setEnd]=useState(30),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[saved,setSaved]=useState<string|null>(null);
  const valid=Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start&&end-start<=300&&(!episode.durationSeconds||end<=episode.durationSeconds);
  async function save(){if(!valid||busy)return;setBusy(true);setError(null);try{const path=await exportPodcastClip(episode.id,start,end);if(path){setSaved(path);setOpen(false);}}catch(reason){setError(String(reason));}finally{setBusy(false);}}
  return <><Button variant="ghost" onClick={()=>{const duration=episode.durationSeconds??28800;const start=Math.min(Math.max(0,position),Math.max(0,duration-1));setStart(start);setEnd(Math.min(duration,start+30));setError(null);setOpen(true);}}>导出片段</Button>{saved&&<p className="podcast-clip-saved" role="status">片段已保存：{saved}</p>}
    <Presence show={open} exitDurationMs={MOTION_DURATIONS.micro}><Dialog titleId="podcast-clip-title" kicker="播客" title="导出片段" className="podcast-clip-dialog" busy={busy} onCancel={()=>setOpen(false)} onSubmit={event=>{event.preventDefault();void save();}} actions={<><Button disabled={busy} onClick={()=>setOpen(false)}>取消</Button><Button variant="primary" disabled={!valid||!episode.localPath} busy={busy} onClick={()=>void save()}>选择保存位置</Button></>}>
      <p>{episode.title}</p><div className="podcast-playback-setting-grid">{([["片段开始",start,setStart],["片段结束",end,setEnd]] as const).map(([label,value,set])=><label key={label}>{label}<span><input type="number" aria-label={label} min={0} max={episode.durationSeconds??28800} step={0.1} value={value} disabled={busy} onChange={event=>set(Number(event.target.value))}/> 秒</span></label>)}</div><p>{formatTime(start)} – {formatTime(end)} · {formatTime(Math.max(0,end-start))}</p><small>导出本机音频为 WAV，最多 5 分钟。</small>{!episode.localPath&&<p>本集需要先下载完整音频。</p>}{!valid&&<p role="alert">请选择本集时长内、最多 5 分钟的片段。</p>}{error&&<p role="alert">{error}</p>}
    </Dialog></Presence></>;
}
