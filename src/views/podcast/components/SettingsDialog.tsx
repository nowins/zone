import { CloudSettings } from "./CloudSettings";
import { Select } from "../../../components/Select";
import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { MetroLoader } from "../../../components/MetroLoader";
import { getPodcastPreferences, setPodcastPreferences, testPodcastNotification, type PodcastPreferences } from "../api";
import { PODCAST_PLAYBACK_RATES, readPodcastPlaybackSettings } from "../../../app/podcastPlaybackSettings";
import { effectivePodcastPreferences } from "../../../utils/podcastPreferences.js";

export function PodcastSettingsDialog(props: { feedId?: string; title: string; onClose: () => void }) {
  return <PodcastPreferencesEditor {...props} />;
}
export function PodcastDefaultsSettings() { return <PodcastPreferencesEditor title="播客" embedded />; }
function PreferenceToggle({label, value, disabled, onChange}: {label:string;value:boolean;disabled:boolean;onChange:()=>void}) {
  return <div className="podcast-preference-toggle"><span>{label}</span><button className="provider-toggle" type="button" role="switch" aria-label={label} aria-checked={value} disabled={disabled} onClick={onChange}><span aria-hidden="true"/>{value ? "已启用" : "已关闭"}</button></div>;
}
function PodcastPreferencesEditor({ feedId, title, onClose, embedded = false }: { feedId?: string; title: string; onClose?: () => void; embedded?: boolean }) {
  const [value, setValue] = useState<PodcastPreferences | null>(null);
  const [defaults, setDefaults] = useState<PodcastPreferences | null>(null);
  const [tab, setTab] = useState<"playback" | "downloads" | "updates" | "cloud">("playback");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [cloudVisited,setCloudVisited]=useState(false);
  const [testSent,setTestSent]=useState(false);
  const [dirty, setDirty] = useState(false), [saved, setSaved] = useState(false);
  function update(next: PodcastPreferences) { setValue(next); setDirty(true); setSaved(false); }
  useEffect(() => {
    let disposed = false; setError(null); setValue(null);
    void Promise.all([getPodcastPreferences(feedId), feedId ? getPodcastPreferences() : Promise.resolve(null)])
      .then(([next, global]) => { if (!disposed) { setValue(next); setDefaults(global); setDirty(false); } })
      .catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [feedId, revision]);
  async function save() {
    if (!value || busy) return;
    setBusy(true); setError(null);
    try { await setPodcastPreferences(value, feedId); setDirty(false); setSaved(true); onClose?.(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  const inherited = Boolean(feedId && value?.inheritPlayback);
  const effective = effectivePodcastPreferences(defaults, value);
  const displayed = inherited ? effective : value;
  const defaultRate = defaults?.playbackRate ?? readPodcastPlaybackSettings().playbackRate;
  const fields = <>
    {tab!=="cloud"&&<p className="podcast-settings-scope">{feedId ? "设置应用于本节目" : "默认设置应用于沿用默认偏好的节目"}</p>}
    <div className="podcast-settings-tabs podcast-library-tabs" role="group" aria-label="设置分类">
      <Button variant="ghost" disabled={busy} aria-pressed={tab === "playback"} onClick={() => setTab("playback")}>播放偏好</Button>
      <Button variant="ghost" disabled={busy} aria-pressed={tab === "downloads"} onClick={() => setTab("downloads")}>下载与清理</Button>
      <Button variant="ghost" disabled={busy} aria-pressed={tab === "updates"} onClick={() => setTab("updates")}>更新提醒</Button>
      {!feedId && <Button variant="ghost" disabled={busy} aria-pressed={tab === "cloud"} onClick={()=>{setCloudVisited(true);setTab("cloud");}}>转写服务</Button>}
    </div>
    {!feedId&&cloudVisited&&<div hidden={tab!=="cloud"}><CloudSettings/></div>}
    {tab === "cloud" ? null : value && displayed ? <div className="podcast-settings-fields">
      {tab === "updates" ? <>
        {feedId && <PreferenceToggle label="使用默认提醒设置" value={value.notifyNewEpisodes == null} disabled={busy} onChange={()=>update({...value,notifyNewEpisodes:value.notifyNewEpisodes==null?(defaults?.notifyNewEpisodes??false):null})}/>}
        <PreferenceToggle label="Windows 新单集通知" value={Boolean(value.notifyNewEpisodes??defaults?.notifyNewEpisodes)} disabled={busy||Boolean(feedId&&value.notifyNewEpisodes==null)} onChange={()=>update({...value,notifyNewEpisodes:!value.notifyNewEpisodes})}/>
        <small>首页已固定的节目始终显示更新角标。打开节目后清除提示；收听进度保持不变。</small>
        <Button variant="ghost" disabled={busy} onClick={()=>{setBusy(true);setError(null);void testPodcastNotification().then(()=>setTestSent(true)).catch(reason=>setError(String(reason))).finally(()=>setBusy(false));}}>发送测试提醒</Button>{testSent&&<small role="status">测试提醒已提交给 Windows</small>}
      </> : tab === "downloads" ? <>
        {feedId ? <label>自动下载最新单集
          <Select disabled={busy} aria-label="自动下载最新单集" value={value.autoDownloadCount} onValueChange={nextValue => update({ ...value, autoDownloadCount: Number(nextValue) })}>
            {[0,1,3,5,10,20,50].map(n => <option key={n} value={n}>{n ? n + " 集" : "关闭"}</option>)}
          </Select></label> : <label>下载空间上限
          <Select disabled={busy} aria-label="下载空间上限" value={value.storageLimitMb} onValueChange={nextValue => update({ ...value, storageLimitMb: Number(nextValue) })}>
            {[0,512,1024,2048,5120,10240].map(n => <option key={n} value={n}>{n ? n >= 1024 ? n / 1024 + " GB" : n + " MB" : "不限"}</option>)}
          </Select></label>}
        <PreferenceToggle label="自动清理已听完下载" value={value.cleanupPlayed} disabled={busy} onChange={() => update({ ...value, cleanupPlayed: !value.cleanupPlayed })} />
        <small>自动清理保留正在收听、稍后听、手动列表和待播单集。</small>
        {!feedId && <small>空间上限包含未完成文件，在新下载开始时应用。</small>}
      </> : <fieldset className="podcast-playback-settings"><legend className="podcast-heading-hidden">{feedId ? "本节目播放偏好" : "默认播放偏好"}</legend>
        {feedId && <PreferenceToggle label="使用默认播放设置" value={value.inheritPlayback} disabled={busy} onChange={() => update({ ...value, inheritPlayback: !value.inheritPlayback })} />}
        {inherited && <p className="podcast-settings-effective" role="status">正在沿用默认设置 · 以下显示实际生效值</p>}
        <div className="podcast-playback-setting-grid">
          <label>播放速度<Select disabled={inherited || busy} aria-label="节目播放速度" value={displayed.playbackRate ?? 0} onValueChange={nextValue => update({ ...value, playbackRate: Number(nextValue) || null })}>
            <option value={0}>{feedId ? "默认 " + defaultRate + "×" : defaultRate + "×（当前默认）"}</option>
            {Array.from(new Set([...PODCAST_PLAYBACK_RATES, ...(displayed.playbackRate ? [displayed.playbackRate] : [])])).sort((a,b) => a-b).map(rate => <option key={rate} value={rate}>{rate}×</option>)}
          </Select></label>

          <label>同节目续播<Select disabled={inherited || busy} aria-label="节目播放顺序" value={displayed.oldestFirst ? "oldest" : "newest"} onValueChange={nextValue => update({ ...value, oldestFirst: nextValue === "oldest" })}><option value="newest">由新到旧</option><option value="oldest">由旧到新</option></Select></label>
        </div>
        <PreferenceToggle label="均衡语音音量" value={displayed.normalizeVoice} disabled={inherited || busy} onChange={() => update({ ...value, normalizeVoice: !value.normalizeVoice })} />
        <PreferenceToggle label="加速静音段落" value={displayed.trimSilence} disabled={inherited || busy} onChange={() => update({ ...value, trimSilence: !value.trimSilence })} />
        <details className="podcast-preference-advanced"><summary>片头、片尾与跳转</summary><div className="podcast-playback-setting-grid">
          {([["introSeconds","跳过片头",0,3600],["outroSeconds","跳过片尾",0,3600],["backwardSeconds","后退间隔",1,300],["forwardSeconds","前进间隔",1,300]] as const).map(([key,label,min,max]) => <label key={key}>{label}<span><input disabled={inherited || busy} type="number" aria-label={label} min={min} max={max} step={1} value={displayed[key]} onChange={event => update({ ...value, [key]: Number(event.target.value) })} /> 秒</span></label>)}
        </div></details>
        <small>均衡语音音量减小音量差异；静音段临时加速，恢复声音后回到所选倍速。</small>
      </fieldset>}
    </div> : error ? null : <p role="status"><MetroLoader />正在读取设置</p>}
    {error && <p role="alert">{error}{!value && <Button onClick={() => setRevision(value => value + 1)}>重试读取</Button>}</p>}
  </>;
  if (embedded) return <form className="podcast-default-settings" aria-label="播客默认偏好" onSubmit={event => { event.preventDefault(); void save(); }}>{fields}
    {tab!=="cloud" && <div className="podcast-preference-save"><span role="status">{dirty ? "有未保存的修改" : saved ? "已保存播客偏好" : ""}</span><Button type="submit" variant="primary" disabled={!value || !dirty} busy={busy}>保存修改</Button></div>}
  </form>;
  return <Dialog titleId="podcast-settings-title" kicker="节目设置" title={title} overlayClassName="podcast-settings-overlay" className="podcast-settings-dialog" busy={busy} onCancel={() => onClose?.()}
    onSubmit={event => { event.preventDefault(); void save(); }} actions={<><Button disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant="primary" disabled={!value} busy={busy}>保存</Button></>}><div className="podcast-settings-content">{fields}</div></Dialog>;
}
