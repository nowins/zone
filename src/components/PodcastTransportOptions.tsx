import { useState } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { PODCAST_PLAYBACK_RATES } from "../app/podcastPlaybackSettings";
import type { PodcastSleepTimer } from "../types";

export function PodcastTransportOptions({ rate, timer, episodeId, onRate, onTimer, onClose }: { rate: number; timer: PodcastSleepTimer; episodeId: string; onRate: (value: number) => void; onTimer: (value: PodcastSleepTimer) => void; onClose: () => void }) {
  const [minutes, setMinutes] = useState(30);
  return <Dialog titleId="podcast-transport-options-title" overlayClassName="podcast-bar-options-overlay" className="podcast-bar-options-dialog" title="播放选项" kicker="播客" onCancel={onClose} onSubmit={event=>{event.preventDefault();onClose();}}
    actions={<Button variant="primary" onClick={onClose}>完成</Button>}>
    <fieldset className="podcast-bar-rates"><legend>播放速度</legend><div role="group" aria-label="底栏播放速度">{Array.from(new Set([...PODCAST_PLAYBACK_RATES,rate])).sort((a,b)=>a-b).map(value=><Button key={value} variant="ghost" aria-pressed={rate===value} onClick={()=>onRate(value)}>{value}×</Button>)}</div></fieldset>
    <fieldset className="podcast-bar-sleep"><legend>睡眠定时</legend><div><Button aria-pressed={!timer} onClick={()=>onTimer(null)}>关闭定时</Button><Button aria-pressed={timer?.kind==="episodeEnd"} onClick={()=>onTimer({kind:"episodeEnd",episodeId})}>本集结束</Button></div>
      <label>分钟 <input type="number" aria-label="睡眠分钟" min={1} max={240} step={1} value={minutes} onChange={event=>setMinutes(Number(event.target.value))}/></label><Button disabled={!Number.isInteger(minutes)||minutes<1||minutes>240} onClick={()=>onTimer({kind:"deadline",deadlineAt:Date.now()+minutes*60000})}>设置定时</Button>
      {timer && <p role="status">{timer.kind==="episodeEnd"?"本集结束后暂停":`将在 ${new Date(timer.deadlineAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})} 暂停`}</p>}
    </fieldset>
  </Dialog>;
}
