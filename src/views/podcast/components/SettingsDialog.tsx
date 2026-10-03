import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { MetroLoader } from "../../../components/MetroLoader";
import { getPodcastPreferences, setPodcastPreferences, type PodcastPreferences } from "../api";

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
      <small>保留正在收听、稍后听和待播单集；达到空间上限后暂停新增下载。</small>
    </div> : error ? null : <p role="status"><MetroLoader />正在读取设置</p>}
    {error && <p role="alert">{error}</p>}
  </Dialog>;
}
