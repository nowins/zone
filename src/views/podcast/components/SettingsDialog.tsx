import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { MetroLoader } from "../../../components/MetroLoader";
import { getPodcastPreferences, setPodcastPreferences, type PodcastPreferences } from "../api";
import { PODCAST_PLAYBACK_RATES, readPodcastPlaybackSettings } from "../../../app/podcastPlaybackSettings";
import { effectivePodcastPreferences } from "../../../utils/podcastPreferences.js";

export function PodcastSettingsDialog({ feedId, title, onClose }: { feedId?: string; title: string; onClose: () => void }) {
  const [value, setValue] = useState<PodcastPreferences | null>(null);
  const [defaults, setDefaults] = useState<PodcastPreferences | null>(null);
  const [tab, setTab] = useState<"playback" | "downloads">("playback");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false; setError(null);
    void Promise.all([getPodcastPreferences(feedId), feedId ? getPodcastPreferences() : Promise.resolve(null)])
      .then(([next, global]) => { if (!disposed) { setValue(next); setDefaults(global); } })
      .catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [feedId, revision]);
  async function save() {
    if (!value || busy) return;
    setBusy(true); setError(null);
    try { await setPodcastPreferences(value, feedId); onClose(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  const inherited = Boolean(feedId && value?.inheritPlayback);
  const effective = effectivePodcastPreferences(defaults, value);
  const displayed = inherited ? effective : value;
  const defaultRate = defaults?.playbackRate ?? readPodcastPlaybackSettings().playbackRate;
  return <Dialog titleId="podcast-settings-title" kicker={feedId ? "节目设置" : "播客设置"} title={title}
    overlayClassName="podcast-settings-overlay" className="podcast-settings-dialog" busy={busy} onCancel={onClose}
    onSubmit={event => { event.preventDefault(); void save(); }}
    actions={<><Button type="submit" variant="primary" disabled={!value} busy={busy}>保存</Button><Button disabled={busy} onClick={onClose}>取消</Button></>}>
    <p className="podcast-settings-scope">{feedId ? "设置应用于本节目" : "默认设置应用于沿用默认偏好的节目"}</p>
    <div className="podcast-settings-tabs podcast-library-tabs" role="group" aria-label="设置分类">
      <Button variant="ghost" disabled={busy} aria-pressed={tab === "playback"} onClick={() => setTab("playback")}>播放偏好</Button>
      <Button variant="ghost" disabled={busy} aria-pressed={tab === "downloads"} onClick={() => setTab("downloads")}>下载与清理</Button>
    </div>
    {value && displayed ? <div className="podcast-settings-fields">
      {tab === "downloads" ? <>
        {feedId ? <label>自动下载最新单集
          <select disabled={busy} aria-label="自动下载最新单集" value={value.autoDownloadCount} onChange={event => setValue({ ...value, autoDownloadCount: Number(event.target.value) })}>
            {[0,1,3,5,10,20,50].map(n => <option key={n} value={n}>{n ? n + " 集" : "关闭"}</option>)}
          </select></label> : <label>下载空间上限
          <select disabled={busy} aria-label="下载空间上限" value={value.storageLimitMb} onChange={event => setValue({ ...value, storageLimitMb: Number(event.target.value) })}>
            {[0,512,1024,2048,5120,10240].map(n => <option key={n} value={n}>{n ? n >= 1024 ? n / 1024 + " GB" : n + " MB" : "不限"}</option>)}
          </select></label>}
        <label className="podcast-setting-check"><input type="checkbox" disabled={busy} checked={value.cleanupPlayed}
          onChange={event => setValue({ ...value, cleanupPlayed: event.target.checked })} />自动清理已听完下载</label>
        <small>自动清理保留正在收听、稍后听、手动列表和待播单集。</small>
        {!feedId && <small>空间上限包含未完成文件，在新下载开始时应用。</small>}
      </> : <fieldset className="podcast-playback-settings"><legend>{feedId ? "本节目播放偏好" : "默认播放偏好"}</legend>
        {feedId && <label className="podcast-setting-check"><input type="checkbox" disabled={busy} checked={value.inheritPlayback}
          onChange={event => setValue({ ...value, inheritPlayback: event.target.checked })} />使用默认播放设置</label>}
        {inherited && <p className="podcast-settings-effective" role="status">正在沿用默认设置 · 以下显示实际生效值</p>}
        <div className="podcast-playback-setting-grid">
          <label>播放速度<select disabled={inherited || busy} aria-label="节目播放速度" value={displayed.playbackRate ?? 0} onChange={event => setValue({ ...value, playbackRate: Number(event.target.value) || null })}>
            <option value={0}>{feedId ? "默认 " + defaultRate + "×" : defaultRate + "×（当前默认）"}</option>
            {Array.from(new Set([...PODCAST_PLAYBACK_RATES, ...(displayed.playbackRate ? [displayed.playbackRate] : [])])).sort((a,b) => a-b).map(rate => <option key={rate} value={rate}>{rate}×</option>)}
          </select></label>
          {([["introSeconds","跳过片头",0,3600],["outroSeconds","跳过片尾",0,3600],["backwardSeconds","后退间隔",1,300],["forwardSeconds","前进间隔",1,300]] as const).map(([key,label,min,max]) => <label key={key}>{label}<span><input disabled={inherited || busy} type="number" aria-label={label} min={min} max={max} step={1} value={displayed[key]} onChange={event => setValue({ ...value, [key]: Number(event.target.value) })} /> 秒</span></label>)}
          <label>同节目续播<select disabled={inherited || busy} aria-label="节目播放顺序" value={displayed.oldestFirst ? "oldest" : "newest"} onChange={event => setValue({ ...value, oldestFirst: event.target.value === "oldest" })}><option value="newest">由新到旧</option><option value="oldest">由旧到新</option></select></label>
        </div>
        <label className="podcast-setting-check"><input type="checkbox" disabled={inherited || busy} checked={displayed.normalizeVoice} onChange={event => setValue({ ...value, normalizeVoice: event.target.checked })} />均衡语音音量</label>
        <label className="podcast-setting-check"><input type="checkbox" disabled={inherited || busy} checked={displayed.trimSilence} onChange={event => setValue({ ...value, trimSilence: event.target.checked })} />加速静音段落</label>
        <small>均衡语音音量减小音量差异；静音段临时加速，恢复声音后回到所选倍速。</small>
      </fieldset>}
    </div> : error ? null : <p role="status"><MetroLoader />正在读取设置</p>}
    {error && <p role="alert">{error}{!value && <Button onClick={() => setRevision(value => value + 1)}>重试读取</Button>}</p>}
  </Dialog>;
}
