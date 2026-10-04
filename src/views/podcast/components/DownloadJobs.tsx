import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { listDownloadJobs, enqueueDownload, pauseDownloadJob, clearDownloadPartial, type PodcastDownloadJob } from "../api";
import { formatFileSize } from "../format";

const labels = { queued: "等待下载", running: "正在下载", paused: "已暂停", failed: "下载失败" };
export function DownloadJobs() {
  const [jobs,setJobs]=useState<PodcastDownloadJob[]>([]);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState<string|null>(null);
  const [notice,setNotice]=useState("");
  useEffect(() => {
    let disposed=false;
    let reading=false;
    const read=async()=>{ if(reading) return; reading=true;
      try { const next=await listDownloadJobs(); if(!disposed) {setJobs(next);setError(null);} }
      catch(reason) {if(!disposed)setError(String(reason));} finally {reading=false;}
    };
    void read(); const timer=window.setInterval(()=>void read(),2000);
    return()=>{disposed=true;window.clearInterval(timer);};
  },[]);
  async function act(job:PodcastDownloadJob,clear=false) {
    setBusy(job.episodeId);setNotice("");
    try { let released=0;if(clear) released=await clearDownloadPartial(job.episodeId); else if(job.state==="running"||job.state==="queued") await pauseDownloadJob(job.episodeId); else await enqueueDownload(job.episodeId);
      setJobs(await listDownloadJobs()); setError(null);setNotice(clear?`已清除“${job.title}”的未完成文件，释放 ${formatFileSize(released)}`:job.state==="running"||job.state==="queued"?"下载已暂停":"已加入下载任务");
    } catch(reason) {setError(String(reason));} finally {setBusy(null);}
  }
  if(!jobs.length&&!error&&!notice)return null;
  return <section className="podcast-download-jobs" aria-label="下载任务">
    <div className="podcast-section-title"><h2>下载任务</h2><span>{jobs.length}</span></div>
    {error&&<p role="alert">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
    {jobs.map(job=><div className="podcast-download-job" key={job.episodeId}>
      <div><strong>{job.title}</strong><span>{labels[job.state]} · {formatFileSize(job.downloadedBytes)}{job.totalBytes?` / ${formatFileSize(job.totalBytes)} · ${Math.min(100,Math.floor(job.downloadedBytes/job.totalBytes*100))}%`:""}</span>
        {job.error&&<small>{job.error}</small>}</div>
      <div className="podcast-download-job-actions"><Button variant="ghost" busy={busy===job.episodeId} disabled={busy!==null} onClick={()=>void act(job)}>{job.state==="running"||job.state==="queued"?"暂停":"继续下载"}</Button>
      {job.state==="paused"||job.state==="failed"?<Button variant="ghost" disabled={busy!==null||job.downloadedBytes===0} onClick={()=>void act(job,true)}>清除未完成文件</Button>:null}</div>
    </div>)}
  </section>;
}
