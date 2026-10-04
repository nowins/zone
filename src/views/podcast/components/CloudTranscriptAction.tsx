import { useEffect, useState, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { MOTION_DURATIONS } from "../../../motion/tokens";
import { Presence, useLastNonNull } from "../../../motion/presence";
import { cancelPodcastRequest, generateTranscript, getCloudSettings, getEpisodeDetail, type CloudSettings, type TranscriptDocument } from "../api";
import { formatTime } from "../../../utils/music";
export function CloudTranscriptAction({episodeId,source,canTranslate,onGenerated}:{episodeId:string;source:string;canTranslate:boolean;onGenerated:(document:TranscriptDocument,variant:string)=>void}) {
  const [mode,setMode]=useState<"transcribe"|"translate"|null>(null),[settings,setSettings]=useState<CloudSettings|null>(null),[title,setTitle]=useState(""),[duration,setDuration]=useState<number|null>(null),[downloaded,setDownloaded]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[progress,setProgress]=useState("");
  useEffect(()=>{let disposed=false;const listener=listen<{episodeId:string;processedSeconds?:number;processedSegments?:number}>("podcast-cloud-progress",event=>{if(!disposed&&event.payload.episodeId===episodeId)setProgress(event.payload.processedSeconds!==undefined?`已处理 ${formatTime(event.payload.processedSeconds)}`:`已翻译 ${event.payload.processedSegments} 段`);}).catch(()=>()=>{});return()=>{disposed=true;void listener.then(unlisten=>unlisten()).catch(()=>{});void cancelPodcastRequest("cloud").catch(()=>{});};},[episodeId]);
  const owner=useRef(0);useEffect(()=>{owner.current++;return()=>{owner.current++;};},[episodeId]);
  const displayedMode=useLastNonNull(mode);
  async function open(next:"transcribe"|"translate"){const epoch=owner.current;setError(null);setSettings(null);setMode(next);try{const [settings,detail]=await Promise.all([getCloudSettings(),getEpisodeDetail(episodeId)]);if(epoch!==owner.current)return;setSettings(settings);setTitle(detail.episode.title);setDuration(detail.episode.durationSeconds??null);setDownloaded(Boolean(detail.episode.localPath));}catch(reason){if(epoch===owner.current)setError(String(reason));}}
  async function start(){if(!mode||!settings?.hasKey||(mode==="transcribe"&&!downloaded)||(mode==="translate"&&!settings.translationModel))return;setBusy(true);setError(null);setProgress("正在处理");try{const document=await generateTranscript(episodeId,mode,source,settings.baseUrl);onGenerated(document,mode==="transcribe"?"generated":"translated");setMode(null);}catch(reason){setError(String(reason));}finally{setBusy(false);setProgress("");}}
  return <><div className="podcast-cloud-actions"><Button variant="ghost" onClick={()=>void open("transcribe")}>生成转写</Button>{canTranslate&&source!=="translated"&&<Button variant="ghost" onClick={()=>void open("translate")}>翻译为中文</Button>}</div>
    <Presence show={mode!==null} exitDurationMs={MOTION_DURATIONS.micro}><Dialog titleId="podcast-cloud-confirm" title={displayedMode==="translate"?"翻译转写":"生成转写"} kicker="云端处理" className="podcast-cloud-dialog" onSubmit={event=>{event.preventDefault();if(!busy)void start();}} onCancel={()=>{if(busy){void cancelPodcastRequest("cloud").catch(reason=>setError(String(reason)));}else setMode(null);}} actions={<><Button onClick={()=>busy?void cancelPodcastRequest("cloud").catch(reason=>setError(String(reason))):setMode(null)}>{busy?"取消处理":"取消"}</Button><Button variant="primary" disabled={busy||!settings?.hasKey||(mode==="transcribe"&&!downloaded)||(mode==="translate"&&!settings?.translationModel)} onClick={()=>void start()}>确认上传并处理</Button></>}>
      <p>{title}</p>{settings&&<><p className="podcast-cloud-target">{settings.baseUrl}</p><p>{displayedMode==="transcribe"?`上传本集完整音频${duration?`（${formatTime(duration)}）`:""}，按最多 10 分钟分段处理。`:`上传当前选择的完整转写文字，音频留在本机。`}</p><p>结果保存在本机，原文保留。服务可能按用量收费；取消后已发送的部分仍可能计费。</p>{!settings.hasKey&&<p role="status">请先在 设置 → 播客 → 转写服务 配置密钥。</p>}{displayedMode==="transcribe"&&!downloaded&&<p role="status">请先下载本集音频。</p>}{displayedMode==="translate"&&!settings.translationModel&&<p role="status">请先配置翻译模型。</p>}</>}
      {progress&&<p role="status">{progress}</p>}{error&&<p role="alert">{error}</p>}
    </Dialog></Presence>
  </>;
}
