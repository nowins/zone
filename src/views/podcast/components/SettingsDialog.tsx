import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { MetroLoader } from "../../../components/MetroLoader";
import { getPodcastPreferences, setPodcastPreferences, type PodcastPreferences } from "../api";
import { PODCAST_PLAYBACK_RATES } from "../../../app/podcastPlaybackSettings";

export function PodcastSettingsDialog({ feedId, title, onClose }: { feedId?: string; title: string; onClose: () => void }) {
  const [value, setValue] = useState<PodcastPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void getPodcastPreferences(feedId).then(next => { if (!disposed) setValue(next); })
      .catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [feedId]);
  async function save() {
    if (!value || busy) return;
    setBusy(true); setError(null);
    try { await setPodcastPreferences(value, feedId); onClose(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <Dialog titleId="podcast-settings-title" kicker={feedId ? "节目设置" : "播客设置"} title={title}
    className="podcast-settings-dialog" busy={busy} onCancel={onClose}
    onSubmit={event => { event.preventDefault(); void save(); }}
    actions={<><Button type="submit" variant="primary" disabled={!value} busy={busy}>保存</Button><Button disabled={busy} onClick={onClose}>取消</Button></>}>
    {value ? <div className="podcast-settings-fields">
      {feedId ? <label>自动下载最新单集
        <select value={value.autoDownloadCount} onChange={event => setValue({ ...value, autoDownloadCount: Number(event.target.value) })}>
          {[0,1,3,5,10,20,50].map(n => <option key={n} value={n}>{n ? `${n} 集` : "关闭"}</option>)}
        </select></label> : <label>下载空间上限
        <select value={value.storageLimitMb} onChange={event => setValue({ ...value, storageLimitMb: Number(event.target.value) })}>
          {[0,512,1024,2048,5120,10240].map(n => <option key={n} value={n}>{n ? `${n} MB` : "不限"}</option>)}
        </select></label>}
      <label className="podcast-setting-check"><input type="checkbox" checked={value.cleanupPlayed}
        onChange={event => setValue({ ...value, cleanupPlayed: event.target.checked })} />自动清理已听完下载</label>
      <small>保留正在收听、稍后听、手动列表和待播单集；上限计入断点文件，新设置在下载开始时应用。</small>
      <fieldset className="podcast-playback-settings"><legend>播放偏好</legend>
        {feedId && <label className="podcast-setting-check"><input type="checkbox" checked={value.inheritPlayback}
          onChange={event=>setValue({...value,inheritPlayback:event.target.checked})}/>使用默认播放设置</label>}
        <div className="podcast-playback-setting-grid">
          <label>播放速度<select disabled={Boolean(feedId&&value.inheritPlayback)} aria-label="节目播放速度" value={value.playbackRate??0} onChange={event=>setValue({...value,playbackRate:Number(event.target.value)||null})}>
            <option value={0}>沿用默认倍速</option>{Array.from(new Set([...PODCAST_PLAYBACK_RATES,...(value.playbackRate?[value.playbackRate]:[])])).sort((a,b)=>a-b).map(rate=><option key={rate} value={rate}>{rate}×</option>)}</select></label>
          {([["introSeconds","跳过片头",0,3600],["outroSeconds","跳过片尾",0,3600],["backwardSeconds","后退间隔",1,300],["forwardSeconds","前进间隔",1,300]] as const).map(([key,label,min,max])=><label key={key}>{label}<span><input disabled={Boolean(feedId&&value.inheritPlayback)} type="number" aria-label={label} min={min} max={max} step={1} value={value[key]} onChange={event=>setValue({...value,[key]:Number(event.target.value)})}/> 秒</span></label>)}
          <label>同节目续播<select disabled={Boolean(feedId&&value.inheritPlayback)} aria-label="节目播放顺序" value={value.oldestFirst?"oldest":"newest"} onChange={event=>setValue({...value,oldestFirst:event.target.value==="oldest"})}><option value="newest">由新到旧</option><option value="oldest">由旧到新</option></select></label>
        </div>
      </fieldset>
    </div> : error ? null : <p role="status"><MetroLoader />正在读取设置</p>}
    {error && <p role="alert">{error}</p>}
  </Dialog>;
}
