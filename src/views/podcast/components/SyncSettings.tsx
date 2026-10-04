import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { MetroLoader } from "../../../components/MetroLoader";
import { Presence } from "../../../motion/presence";
import { MOTION_DURATIONS } from "../../../motion/tokens";
import { choosePodcastSyncFolder, getPodcastSyncStatus, stopPodcastSync, syncPodcastsNow, type PodcastSyncStatus } from "../api";

function displayFolder(path: string) {
  return path.startsWith("\\\\?\\UNC\\") ? "\\\\" + path.slice(8) : path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

export function PodcastSyncSettings() {
  const [status, setStatus] = useState<PodcastSyncStatus | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [setup, setSetup] = useState(false);
  const generation = useRef(0), pending = useRef(false);
  useEffect(() => {
    let disposed = false, loading = false;
    const load = async () => {
      if (loading || pending.current) return;
      const epoch = generation.current; loading = true;
      try { const value = await getPodcastSyncStatus(); if (!disposed && epoch === generation.current) { setStatus(value); setError(""); } }
      catch (reason) { if (!disposed && epoch === generation.current) setError(String(reason)); }
      finally { loading = false; }
    };
    void load(); const timer = window.setInterval(() => void load(), 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  async function run(action: () => Promise<PodcastSyncStatus>) {
    if (pending.current) return;
    pending.current = true; generation.current++; setBusy(true); setError("");
    try { setStatus(await action()); setSetup(false); }
    catch (reason) { setError(String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  const problem = error || status?.error;
  const syncing = busy || status?.syncing;
  const label = syncing ? "正在同步" : !status ? "正在读取同步状态" : !status.folder ? "同步未开启" : problem ? "同步需要处理" : !status.lastSynced ? "等待首次同步" : "已同步";
  return <section className="podcast-sync-settings podcast-management-section" aria-label="跨设备同步">
    <h2>跨设备同步</h2>
    <p className="podcast-sync-status" role="status">{syncing && <MetroLoader />}{label}</p>
    {status?.folder && <><p className="podcast-sync-path" title={displayFolder(status.folder)}>{displayFolder(status.folder)}</p>
      {status.lastSynced && <p>最近同步 {new Date(status.lastSynced).toLocaleString("zh-CN")}</p>}
      {status.report && <p>已检查 {status.report.devicesRead} 台其他设备 · {status.report.changed ? "已更新关注与进度" : "资料无变化"}{status.report.failedDevices > 0 ? " · " + status.report.failedDevices + " 台暂未合并" : ""}</p>}</>}
    <div className="podcast-management-actions"><Button disabled={Boolean(syncing)} onClick={() => setSetup(true)}>{status?.folder ? "更换同步目录" : "设置同步"}</Button>
      {status?.folder && <><Button disabled={Boolean(syncing)} busy={busy} onClick={() => void run(syncPodcastsNow)}>{problem ? "重试同步" : "立即同步"}</Button><Button variant="ghost" disabled={Boolean(syncing)} onClick={() => void run(stopPodcastSync)}>停止同步</Button></>}
      {!status && error && <Button onClick={() => void run(getPodcastSyncStatus)}>重试读取</Button>}
    </div>
    {problem && <p role="alert">{problem}</p>}
    {status?.folder && <details><summary>同步范围</summary><p>关注状态与收听进度每分钟合并，以最新修改为准。请保持设备时间准确。</p></details>}
    <Presence show={setup} exitDurationMs={MOTION_DURATIONS.micro}><Dialog titleId="podcast-sync-setup" kicker="跨设备同步" title="设置共享目录" className="podcast-collection-dialog" busy={busy} onCancel={() => setSetup(false)} onSubmit={event => { event.preventDefault(); void run(choosePodcastSyncFolder); }}
      actions={<><Button disabled={busy} onClick={() => setSetup(false)}>取消</Button><Button type="submit" variant="primary" busy={busy}>选择同步目录</Button></>}>
      <ol className="podcast-sync-steps"><li>在网盘或共享盘中准备一个播客专用目录。</li><li>每台设备的 Zone 都选择这个目录。</li><li>网盘完成文件传输后，Zone 会合并关注与进度。</li></ol>
      <p>同步每分钟进行一次，也可手动立即同步。设备以最新修改为准，请保持系统时间准确。</p>
      {error && <p role="alert">{error}</p>}
    </Dialog></Presence>
  </section>;
}
