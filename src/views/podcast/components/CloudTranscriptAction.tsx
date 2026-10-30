import { useEffect, useState, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { MOTION_DURATIONS } from "../../../motion/tokens";
import { Presence, useLastNonNull } from "../../../motion/presence";
import { cancelPodcastRequest, generateTranscript, generateLocalTranscript, getCloudSettings, getLocalTranscriptionStatus, getEpisodeDetail, type CloudSettings, type LocalTranscriptionStatus, type TranscriptDocument } from "../api";
import { formatTime } from "../../../utils/music";

export function CloudTranscriptAction({episodeId,source,canTranslate,onGenerated}:{episodeId:string;source:string;canTranslate:boolean;onGenerated:(document:TranscriptDocument,variant:string)=>void}) {
  const [mode,setMode]=useState<"transcribe"|"translate"|null>(null);
  const [cloud,setCloud]=useState<CloudSettings|null>(null),[local,setLocal]=useState<LocalTranscriptionStatus|null>(null);
  const [title,setTitle]=useState(""),[duration,setDuration]=useState<number|null>(null),[downloaded,setDownloaded]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[progress,setProgress]=useState("");
  const owner=useRef(0);
  useEffect(()=>{
    owner.current++;
    let disposed=false;
    setMode(null);setBusy(false);setProgress("");setError(null);
    const listeners=["podcast-cloud-progress","podcast-local-progress"].map(name=>listen<{episodeId:string;processedSeconds?:number;processedSegments?:number}>(name,event=>{
      if(!disposed&&event.payload.episodeId===episodeId)setProgress(event.payload.processedSeconds!==undefined?`已处理 ${formatTime(event.payload.processedSeconds)}`:`已翻译 ${event.payload.processedSegments} 段`);
    }).catch(()=>()=>{}));
    return()=>{disposed=true;owner.current++;for(const listener of listeners)void listener.then(unlisten=>unlisten()).catch(()=>{});for(const key of ["cloud","local-transcript"])void cancelPodcastRequest(key).catch(()=>{});};
  },[episodeId]);
  const displayedMode=useLastNonNull(mode);
  const isLocal=mode==="transcribe"&&local?.settings.backend==="local";
  const selected=local?.models.find(model=>model.id===local.settings.modelId);
  const ready=mode==="translate"?Boolean(cloud?.hasKey&&cloud.translationModel):downloaded&&(isLocal?Boolean(local?.engineReady&&selected?.installed):Boolean(cloud?.hasKey));
  async function open(next:"transcribe"|"translate"){
    const epoch=++owner.current;setError(null);setCloud(null);setLocal(null);setMode(next);setDownloaded(false);
    try{
      const [status,detail]=await Promise.all([getLocalTranscriptionStatus(),getEpisodeDetail(episodeId)]);
      const settings=next==="translate"||status.settings.backend==="cloud"?await getCloudSettings():null;
      if(epoch!==owner.current)return;
      setLocal(status);setCloud(settings);setTitle(detail.episode.title);setDuration(detail.episode.durationSeconds??null);setDownloaded(Boolean(detail.episode.localPath));
    }catch(reason){if(epoch===owner.current)setError(String(reason));}
  }
  async function cancel(){try{await cancelPodcastRequest(isLocal?"local-transcript":"cloud");}catch(reason){setError(String(reason));}}
  async function start(){
    if(!mode||!ready||busy||!local)return;
    const epoch=owner.current;setBusy(true);setError(null);setProgress("正在处理");
    try{
      const document=isLocal?await generateLocalTranscript(episodeId,local.settings):await generateTranscript(episodeId,mode,source,cloud!.baseUrl);
      if(epoch===owner.current){onGenerated(document,mode==="transcribe"?"generated":"translated");setMode(null);}
    }catch(reason){if(epoch===owner.current)setError(String(reason));}
    finally{if(epoch===owner.current){setBusy(false);setProgress("");}}
  }
  return <><div className="podcast-cloud-actions"><Button variant="ghost" disabled={busy} onClick={()=>void open("transcribe")}>生成转写</Button>{canTranslate&&source!=="translated"&&<Button variant="ghost" disabled={busy} onClick={()=>void open("translate")}>翻译为中文 · 云端</Button>}</div>
    <Presence show={mode!==null} exitDurationMs={MOTION_DURATIONS.micro}><Dialog titleId="podcast-cloud-confirm" title={displayedMode==="translate"?"翻译转写":"生成转写"} kicker={isLocal?"本地 CPU 处理":"云端处理"} className="podcast-cloud-dialog" onSubmit={event=>{event.preventDefault();void start();}} onCancel={()=>{if(busy)void cancel();else setMode(null);}} actions={<><Button onClick={()=>busy?void cancel():setMode(null)}>{busy?"取消处理":"取消"}</Button><Button variant="primary" disabled={busy||!ready} onClick={()=>void start()}>{isLocal?"开始本地转写":"确认上传并处理"}</Button></>}>
      <p>{title}</p>
      {isLocal&&local?<>
        <p>本机 CPU · {local.settings.modelId} · {local.settings.language==="auto"?"自动识别语言":local.settings.language==="zh"?"中文":"英语"}</p>
        <p>本集完整音频{duration?`（${formatTime(duration)}）`:""}按 1 分钟分段识别。不上传音频，不会自动切换云端。中文翻译仍为云端功能。</p>
        <p>结果完整通过校验后保存。失败或取消保留已有字幕；处理可能耗时较久。</p>
        {!local.engineReady&&<p role="status">{local.engineError}</p>}
        {!selected?.installed&&<p role="status">请先在 设置 → 播客 → 转写服务 导入所选多语言模型。</p>}
      </>:cloud&&<>
        <p className="podcast-cloud-target">{cloud.baseUrl}</p><p>{displayedMode==="transcribe"?`上传本集完整音频${duration?`（${formatTime(duration)}）`:""}，按最多 10 分钟分段处理。`:"上传当前选择的完整转写文字，音频留在本机。"}</p>
        <p>结果保存在本机，原文保留。服务可能按用量收费；取消后已发送的部分仍可能计费。</p>
        {!cloud.hasKey&&<p role="status">请先在 设置 → 播客 → 转写服务 配置密钥。</p>}{displayedMode==="translate"&&!cloud.translationModel&&<p role="status">请先配置翻译模型。</p>}
      </>}
      {displayedMode==="transcribe"&&local&&!downloaded&&<p role="status">请先下载本集音频。</p>}
      {progress&&<p role="status">{progress}</p>}{error&&<p role="alert">{error}</p>}
    </Dialog></Presence>
  </>;
}