import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../../../components/Button";
type SyncStatus = { folder: string | null; lastSynced: number | null; error: string | null };
export function PodcastSyncSettings() {
  const [status, setStatus] = useState<SyncStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { let disposed = false; let loading = false; const load = async () => { if (loading) return; loading = true; try { const value = await invoke<SyncStatus>("podcast_sync_status"); if (!disposed) setStatus(value); } catch (reason) { if (!disposed) setError(String(reason)); } finally { loading = false; } }; void load(); const timer = window.setInterval(() => void load(), 15000); return () => { disposed = true; window.clearInterval(timer); }; }, []);
  async function run(command: string) { if (busy) return; setBusy(true); setError(""); try { setStatus(await invoke<SyncStatus>(command)); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } }
  return <section className="podcast-sync-settings" aria-label="跨设备同步"><h3>跨设备同步</h3><p>选择已有网盘或共享盘中的专用目录，其他设备选择同一目录后，每分钟合并关注状态和收听进度。设备以最新修改为准，请保持系统时间准确。</p><div><Button disabled={busy} onClick={() => void run("podcast_choose_sync_folder")}>{status?.folder ? "更换同步目录" : "选择同步目录"}</Button>{status?.folder && <><Button disabled={busy} busy={busy} onClick={() => void run("podcast_sync_now")}>立即同步</Button><Button disabled={busy} onClick={() => void run("podcast_stop_sync")}>停止同步</Button></>}</div>{status?.folder && <p className="podcast-sync-path" title={status.folder}>{status.folder}</p>}<p role="status">{status?.folder ? status.lastSynced ? `上次同步 ${new Date(status.lastSynced).toLocaleString("zh-CN")}` : "等待首次同步" : "同步未开启"}</p>{(error || status?.error) && <p role="alert">{error || status?.error}</p>}</section>;
}
