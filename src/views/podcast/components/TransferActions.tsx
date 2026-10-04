import { useState } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Presence, useLastNonNull } from "../../../motion/presence";
import { MOTION_DURATIONS } from "../../../motion/tokens";
import { PodcastSyncSettings } from "./SyncSettings";
import { formatFileSize } from "../format";
import { choosePodcastRestoreBackup, confirmPodcastRestoreBackup, exportPodcastBackup, exportPodcastSubscriptions, importPodcastSubscriptions, openPodcastBackupFolder, retryPodcastImport, type PodcastBackupExport, type PodcastBackupPreview, type PodcastImportReport } from "../api";

export function TransferActions() {
  const [busy,setBusy]=useState<string|null>(null), [message,setMessage]=useState<string|null>(null), [error,setError]=useState<string|null>(null);
  const [includeAudio,setIncludeAudio]=useState(true), [restore,setRestore]=useState<PodcastBackupPreview|null>(null);
  const [report,setReport]=useState<PodcastImportReport|null>(null), [lastBackup,setLastBackup]=useState<PodcastBackupExport|null>(null);
  const restoreSnapshot=useLastNonNull(restore);
  async function run(kind:"import"|"retry"|"export"|"backup"|"choose"|"restore"|"location") {
    if(busy)return;
    setBusy(kind);setError(null);setMessage(null);
    try {
      if(kind==="import" || kind==="retry") {
        const next=kind==="import" ? await importPodcastSubscriptions() : await retryPodcastImport(report?.failedUrls ?? []);
        if(next) {
          const combined=kind==="retry" && report ? {...next,imported:report.imported+next.imported,skipped:report.skipped+next.skipped} : next;
          setReport(combined);setMessage("已导入 "+combined.imported+" 个节目，已有 "+combined.skipped+" 个，失败 "+combined.failures.length+" 个");
        }
      } else if(kind==="export") {if(await exportPodcastSubscriptions())setMessage("订阅已导出");}
      else if(kind==="backup") {
        const frontendSettings=Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith("zone-podcast-")).map(key=>[key,localStorage.getItem(key)]));
        const result=await exportPodcastBackup(frontendSettings,includeAudio);
        if(result){setLastBackup(result);setMessage("已保存 "+result.fileName+" · 含 "+result.audioCount+" 个音频"+(result.audioCount?"，请一起保留音频目录":""));}
      } else if(kind==="choose") {
        const preview=await choosePodcastRestoreBackup();if(preview)setRestore(preview);
      } else if(kind==="restore" && restore) {
        const result=await confirmPodcastRestoreBackup(restore.token);
        for(const [key,value] of Object.entries(result.frontend)){if(key.startsWith("zone-podcast-")&&!localStorage.getItem(key))localStorage.setItem(key,value);}
        setMessage("已合并 "+result.counts.mergedRecords+" 条资料，保留已有 "+result.counts.retainedRecords+" 条，"+result.counts.audioCount+" 个音频可离线收听；播放设置将在重启后恢复");
        setRestore(null);
      } else if(kind==="location" && lastBackup) await openPodcastBackupFolder(lastBackup.locationToken);
    } catch(reason){setError(typeof reason==="string"?reason:"操作未完成，请重试");if(kind==="choose")setRestore(null);}
    finally{setBusy(null);}
  }
  return <div className="podcast-transfer-actions">
    <section className="podcast-management-section" aria-label="订阅迁移"><h2>订阅迁移</h2><div className="podcast-management-actions">
      <Button disabled={busy!==null} busy={busy==="import"} onClick={()=>void run("import")}>导入订阅</Button>
      <Button disabled={busy!==null} busy={busy==="export"} onClick={()=>void run("export")}>导出订阅</Button>
      {report?.failedUrls.length ? <Button disabled={busy!==null} busy={busy==="retry"} onClick={()=>void run("retry")}>重试失败项</Button> : null}
    </div>{report?.failures.length ? <details className="podcast-import-failures"><summary>失败的 {report.failures.length} 个节目</summary><ul>{report.failures.map((failure,index)=><li key={index}>{failure}</li>)}</ul></details> : null}</section>
    <section className="podcast-management-section" aria-label="资料备份"><h2>资料备份</h2><div className="podcast-management-actions">
      <Button disabled={busy!==null} busy={busy==="backup"} onClick={()=>void run("backup")}>备份资料</Button>
      <Button disabled={busy!==null} busy={busy==="choose"} onClick={()=>void run("choose")}>恢复资料</Button>
      <label><input type="checkbox" checked={includeAudio} disabled={busy!==null} onChange={event=>setIncludeAudio(event.target.checked)} />包含已下载音频</label>
      {lastBackup && <Button variant="ghost" disabled={busy!==null} busy={busy==="location"} onClick={()=>void run("location")}>打开备份位置</Button>}
    </div></section>
    {message&&<p role="status">{message}</p>}{!restore&&error&&<p role="alert">{error}</p>}
    <PodcastSyncSettings />
    <Presence show={restore!==null} exitDurationMs={MOTION_DURATIONS.micro}>{restoreSnapshot?<Dialog titleId="podcast-restore-title" kicker="资料恢复" title="合并播客资料" className="podcast-collection-dialog" busy={busy!==null}
      onCancel={()=>setRestore(null)} onSubmit={event=>{event.preventDefault();void run("restore");}}
      actions={<><Button variant="ghost" disabled={busy!==null} onClick={()=>void run("choose")}>重新选择</Button><Button disabled={busy!==null} onClick={()=>setRestore(null)}>取消</Button><Button type="submit" variant="primary" busy={busy==="restore"}>{error?"重试合并":"确认合并"}</Button></>}>
      <p className="podcast-backup-file">{restoreSnapshot.fileName}</p>
      <p className="podcast-section-note">{restoreSnapshot.createdAt ? new Date(restoreSnapshot.createdAt).toLocaleString("zh-CN") : "旧版备份 · 日期未知"}</p>
      <dl className="podcast-restore-summary">{[["节目",restoreSnapshot.feeds],["单集",restoreSnapshot.episodes],["收听进度",restoreSnapshot.progress],["我的列表",restoreSnapshot.lists],["节目分组",restoreSnapshot.groups],["时间书签",restoreSnapshot.bookmarks]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p>{restoreSnapshot.audioCount ? "已校验 "+restoreSnapshot.audioCount+" 个音频 · "+formatFileSize(restoreSnapshot.audioBytes) : "不含音频文件"}</p>
      <p className="podcast-section-note">保留当前资料，合并缺少的记录与较新收听进度／设置。</p>
      {error&&<p role="alert">{error}</p>}
    </Dialog>:<span style={{display:"none"}}/>}</Presence>
  </div>;
}
