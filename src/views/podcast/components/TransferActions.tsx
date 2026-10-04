import { useEffect, useState } from "react";
import { Select } from "../../../components/Select";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { MetroLoader } from "../../../components/MetroLoader";
import { Presence, useLastNonNull } from "../../../motion/presence";
import { MOTION_DURATIONS } from "../../../motion/tokens";
import { PodcastSyncSettings } from "./SyncSettings";
import { formatFileSize } from "../format";
import { createPodcastBackup, getPodcastBackupStorage, openManagedPodcastBackupFolder, setPodcastBackupSchedule, previewManagedPodcastBackup, type PodcastBackupStorage, type PodcastBackupSchedule, choosePodcastRestoreBackup, confirmPodcastRestoreBackup, exportPodcastBackup, exportPodcastSubscriptions, importPodcastSubscriptions, openPodcastBackupFolder, retryPodcastImport, type PodcastBackupExport, type PodcastBackupPreview, type PodcastImportReport } from "../api";

export function TransferActions() {
  const [busy,setBusy]=useState<string|null>(null), [message,setMessage]=useState<string|null>(null), [error,setError]=useState<string|null>(null);
  const [includeAudio,setIncludeAudio]=useState(false), [restore,setRestore]=useState<PodcastBackupPreview|null>(null);
  const [report,setReport]=useState<PodcastImportReport|null>(null), [lastBackup,setLastBackup]=useState<PodcastBackupExport|null>(null);
  const restoreSnapshot=useLastNonNull(restore);
  const [storage, setStorage] = useState<PodcastBackupStorage | null>(null), [storageError, setStorageError] = useState("");
  const [historyOpen,setHistoryOpen]=useState(false),[schedule,setSchedule]=useState<PodcastBackupSchedule|null>(null);
  useEffect(() => { let disposed=false; void getPodcastBackupStorage().then(value => { if(!disposed)setStorage(value); }).catch(() => { if(!disposed)setStorageError("无法读取本机备份，请重试"); }); return () => { disposed=true; }; }, []);
  async function refreshStorage() { try { setStorage(await getPodcastBackupStorage()); setStorageError(""); } catch { setStorageError("无法读取本机备份，请重试"); } }
  function frontendSettings(){return Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith("zone-podcast-")).map(key=>[key,localStorage.getItem(key)!]));}
  async function saveSchedule(){if(busy||!schedule)return;setBusy("schedule");setError(null);try{await setPodcastBackupSchedule(schedule,frontendSettings());setSchedule(null);await refreshStorage();setMessage(schedule.intervalDays?"已开启自动备份，应用运行时按计划保存；关闭应用时顺延至下次启动。":"已关闭自动备份，已有备份保留。");}catch(reason){setError(String(reason));}finally{setBusy(null);}}
  async function previewHistory(name:string){if(busy)return;setBusy("preview");setError(null);try{setRestore(await previewManagedPodcastBackup(name));setHistoryOpen(false);}catch(reason){setError(String(reason));}finally{setBusy(null);}}
  async function run(kind:"import"|"retry"|"export"|"backup"|"exportBackup"|"managedLocation"|"choose"|"restore"|"location") {
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
      else if(kind==="backup" || kind==="exportBackup") {
        const settings=frontendSettings();
        const result=kind==="backup" ? await createPodcastBackup(settings,includeAudio) : await exportPodcastBackup(settings,includeAudio);
        if(result){if(kind==="exportBackup")setLastBackup(result);setMessage((kind==="backup" ? "本机备份已保存 · " : "已导出 · ")+result.fileName+" · 含 "+result.audioCount+" 个音频");if(kind==="backup")await refreshStorage();}
      } else if(kind==="choose") {
        const preview=await choosePodcastRestoreBackup();if(preview)setRestore(preview);
      } else if(kind==="restore" && restore) {
        const result=await confirmPodcastRestoreBackup(restore.token);
        for(const [key,value] of Object.entries(result.frontend)){if(key.startsWith("zone-podcast-")&&!localStorage.getItem(key))localStorage.setItem(key,value);}
        setMessage("已合并 "+result.counts.mergedRecords+" 条资料，保留已有 "+result.counts.retainedRecords+" 条，"+result.counts.audioCount+" 个音频可离线收听；播放设置将在重启后恢复");
        setRestore(null);
      } else if(kind==="managedLocation") await openManagedPodcastBackupFolder();
      else if(kind==="location" && lastBackup) await openPodcastBackupFolder(lastBackup.locationToken);
    } catch(reason){setError(typeof reason==="string"?reason:"操作未完成，请重试");if(kind==="choose")setRestore(null);}
    finally{setBusy(null);}
  }
  return <div className="podcast-transfer-actions">
    <section className="podcast-management-section" aria-label="资料备份">
      <div className="podcast-management-heading"><h2>资料备份</h2><p>关注、进度、列表与偏好</p><p>保存在 Zone 本机目录</p></div>
      <div className="podcast-management-body">
        {!storage && !storageError ? <p role="status"><MetroLoader /> 读取本机备份</p> : storage && <p className="podcast-backup-status">{storage.latest ? "最近备份 " + (storage.latest.createdAt ? new Date(storage.latest.createdAt).toLocaleString("zh-CN") : "日期未知") : "尚未创建本机备份"}</p>}
        <div className="podcast-management-actions"><Button variant="primary" disabled={busy!==null} busy={busy==="backup"} onClick={()=>void run("backup")}>立即备份</Button><Button variant="ghost" disabled={busy!==null} busy={busy==="choose"} onClick={()=>void run("choose")}>恢复资料</Button><Button variant="ghost" disabled={busy!==null||!storage?.history?.length} onClick={()=>setHistoryOpen(true)}>备份历史</Button><Button variant="ghost" disabled={busy!==null} busy={busy==="managedLocation"} onClick={()=>void run("managedLocation")}>打开备份目录</Button></div>
        <div className="podcast-backup-options"><div className="podcast-backup-option"><span>包含已下载音频</span><button className="provider-toggle" type="button" role="switch" aria-label="包含已下载音频" aria-checked={includeAudio} disabled={busy!==null} onClick={()=>setIncludeAudio(value=>!value)}><span aria-hidden="true"/>{includeAudio ? "已启用" : "已关闭"}</button></div>
        {storageError && <p role="alert">{storageError}<Button variant="ghost" onClick={()=>void refreshStorage()}>重试读取</Button></p>}
        <details className="podcast-backup-export"><summary>导出到其他位置</summary><Button variant="ghost" disabled={busy!==null} busy={busy==="exportBackup"} onClick={()=>void run("exportBackup")}>导出资料副本</Button>{lastBackup && <Button variant="ghost" disabled={busy!==null} busy={busy==="location"} onClick={()=>void run("location")}>打开导出位置</Button>}</details></div>
        <details className="podcast-backup-schedule"><summary>自动备份 · {(storage?.schedule?.intervalDays??0)===0?"未开启":storage?.schedule?.intervalDays===1?"每天":"每周"}</summary>
          <div className="podcast-playback-setting-grid"><label>备份频率<Select aria-label="自动备份频率" disabled={busy!==null} value={(schedule??storage?.schedule)?.intervalDays??0} onValueChange={value=>setSchedule({...schedule??storage?.schedule??{intervalDays:0,retainCount:7},intervalDays:Number(value)})}><option value={0}>关闭</option><option value={1}>每天</option><option value={7}>每周</option></Select></label>
          <label>自动快照保留<Select aria-label="自动快照保留" disabled={busy!==null} value={(schedule??storage?.schedule)?.retainCount??7} onValueChange={value=>setSchedule({...schedule??storage?.schedule??{intervalDays:0,retainCount:7},retainCount:Number(value)})}>{[3,7,14,30].map(n=><option key={n} value={n}>{n} 份</option>)}</Select></label></div>
          <p className="podcast-section-note">自动快照保存资料，不含音频。超出数量时只清理未被修改的自动快照，手动备份保留。</p>
          <Button disabled={!schedule||busy!==null} busy={busy==="schedule"} onClick={()=>void saveSchedule()}>保存备份计划</Button>
          {storage?.scheduleError&&<p role="alert">{storage.scheduleError}</p>}
        </details>
      </div>
    </section>
    <section className="podcast-management-section" aria-label="订阅迁移">
      <div className="podcast-management-heading"><h2>订阅迁移</h2><p>在播客软件间迁移关注节目</p></div>
      <div className="podcast-management-body"><div className="podcast-management-actions">
        <Button variant="ghost" disabled={busy!==null} busy={busy==="import"} onClick={()=>void run("import")}>导入订阅</Button><Button variant="ghost" disabled={busy!==null} busy={busy==="export"} onClick={()=>void run("export")}>导出订阅</Button>
        {report?.failedUrls.length ? <Button disabled={busy!==null} busy={busy==="retry"} onClick={()=>void run("retry")}>重试失败项</Button> : null}
      </div>{report?.failures.length ? <details className="podcast-import-failures"><summary>失败的 {report.failures.length} 个节目</summary><ul>{report.failures.map((failure,index)=><li key={index}>{failure}</li>)}</ul></details> : null}</div>
    </section>
    <PodcastSyncSettings />
    {message&&<p role="status">{message}</p>}{!restore&&error&&<p role="alert">{error}</p>}
    <Presence show={historyOpen} exitDurationMs={MOTION_DURATIONS.micro}><Dialog titleId="podcast-backup-history-title" kicker="本机备份" title="备份历史" className="podcast-collection-dialog" busy={busy!==null} onSubmit={event=>event.preventDefault()} onCancel={()=>setHistoryOpen(false)} actions={<Button disabled={busy!==null} onClick={()=>setHistoryOpen(false)}>完成</Button>}>
      <p className="podcast-section-note">显示最近 40 份有效快照，恢复前会核对资料和音频。</p>
      <ol className="podcast-backup-history">{storage?.history?.map(item=><li key={item.fileName}><div><strong>{item.createdAt?new Date(item.createdAt).toLocaleString("zh-CN"):"日期未知"}</strong><small>{item.automatic?"自动快照":"手动备份"} · {item.audioCount?`含 ${item.audioCount} 个音频`:"仅资料"}</small></div><Button disabled={busy!==null} onClick={()=>void previewHistory(item.fileName)}>预览恢复</Button></li>)}</ol>
      {error&&<p role="alert">{error}</p>}
    </Dialog></Presence>
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
