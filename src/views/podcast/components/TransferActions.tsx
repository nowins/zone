import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Presence, useLastNonNull } from "../../../motion/presence";
import { MOTION_DURATIONS } from "../../../motion/tokens";
import { PodcastSyncSettings } from "./SyncSettings";

export function TransferActions() {
  const [busy,setBusy]=useState<string|null>(null);
  const [message,setMessage]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [includeAudio,setIncludeAudio]=useState(true);
  const [confirmRestore,setConfirmRestore]=useState(false);
  const restoreSnapshot=useLastNonNull(confirmRestore?true:null);
  async function run(kind:"import"|"export"|"backup"|"restore") {
    setBusy(kind);setError(null);setMessage(null);
    try {
      if(kind==="import") {
        const report=await invoke<{imported:number;skipped:number;failures:string[]}|null>("podcast_import_opml");
        if(report) {setMessage(`已导入 ${report.imported} 个节目，已有 ${report.skipped} 个，失败 ${report.failures.length} 个`);if(report.failures.length)setError(report.failures.slice(0,3).join("；"));}
      } else if(kind==="export") {if(await invoke<boolean>("podcast_export_opml"))setMessage("订阅已导出");}
      else if(kind==="backup") {
        const frontendSettings=Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith("zone-podcast-")).map(key=>[key,localStorage.getItem(key)]));
        if(await invoke<boolean>("podcast_export_backup",{frontendSettings,includeAudio}))setMessage(includeAudio?"资料与音频已备份，请一起保留备份文件和音频目录":"播客资料已备份");
      } else {
        const frontend=await invoke<Record<string,string>|null>("podcast_restore_backup");
        if(frontend){for(const [key,value] of Object.entries(frontend)){if(key.startsWith("zone-podcast-")&&!localStorage.getItem(key))localStorage.setItem(key,value);}setMessage("播客资料已合并，播放设置将在重启后恢复");}
        setConfirmRestore(false);
      }
    } catch(reason){setError(String(reason));}finally{setBusy(null);}
  }
  return <div className="podcast-transfer-actions">
    <div><Button variant="ghost" disabled={busy!==null} busy={busy==="import"} onClick={()=>void run("import")}>导入订阅</Button>
      <Button variant="ghost" disabled={busy!==null} busy={busy==="export"} onClick={()=>void run("export")}>导出订阅</Button></div>
    <div><Button variant="ghost" disabled={busy!==null} busy={busy==="backup"} onClick={()=>void run("backup")}>备份资料</Button>
      <Button variant="ghost" disabled={busy!==null} onClick={()=>setConfirmRestore(true)}>恢复资料</Button>
      <label><input type="checkbox" checked={includeAudio} disabled={busy!==null} onChange={event=>setIncludeAudio(event.target.checked)} />包含已下载音频</label></div>
    {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
    <PodcastSyncSettings />
    <Presence show={confirmRestore} exitDurationMs={MOTION_DURATIONS.micro}>{restoreSnapshot?<Dialog titleId="podcast-restore-title" kicker="资料恢复" title="合并播客资料" busy={busy==="restore"}
      onCancel={()=>setConfirmRestore(false)} onSubmit={event=>{event.preventDefault();void run("restore");}}
      actions={<><Button type="submit" variant="primary" busy={busy==="restore"}>选择备份</Button><Button disabled={busy==="restore"} onClick={()=>setConfirmRestore(false)} autoFocus>取消</Button></>}>
      <p>保留当前订阅和下载，按更新时间合并进度与设置。音频目录须与备份文件放在一起。</p>
    </Dialog>:<span style={{display:"none"}}/>}</Presence>
  </div>;
}
