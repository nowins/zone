import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { formatTime } from "../../../utils/music";
import { cancelPodcastRequest, getTranscript, type TranscriptDocument } from "../api";
import { PodcastLoading } from "./primitives";

export function TranscriptPanel({episodeId,active,progress,onPlayAt}:{episodeId:string;active:boolean;progress:number;onPlayAt:(seconds:number)=>void}) {
  const [open,setOpen]=useState(false);const [document,setDocument]=useState<TranscriptDocument|null>(null);const [error,setError]=useState<string|null>(null);const [busy,setBusy]=useState(false);
  const [query,setQuery]=useState("");const [page,setPage]=useState(0);const [following,setFollowing]=useState(true);const [revision,setRevision]=useState(0);const list=useRef<HTMLOListElement>(null);
  useEffect(()=>{if(!open)return;let disposed=false;setBusy(true);setError(null);
    void getTranscript(episodeId).then(value=>{if(!disposed)setDocument(value);}).catch(reason=>{if(!disposed)setError(String(reason));}).finally(()=>{if(!disposed)setBusy(false);});
    return()=>{disposed=true;void cancelPodcastRequest("transcript").catch(()=>{});};
  },[episodeId,open,revision]);
  const timed=useMemo(()=>document?.cues.map((cue,index)=>({cue,index})).filter(item=>item.cue.startSeconds!==null)??[],[document]);
  let left=0,right=timed.length;while(left<right){const mid=(left+right)>>>1;if(timed[mid].cue.startSeconds!<=progress)left=mid+1;else right=mid;}
  const candidate=active&&left>0?timed[left-1]:null;
  const current=candidate&&(candidate.cue.endSeconds===null||progress<candidate.cue.endSeconds)?candidate.index:-1;
  const matches=useMemo(()=>document?.cues.map((cue,index)=>({cue,index})).filter(({cue})=>`${cue.speaker??""} ${cue.text}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))??[],[document,query]);
  const effectivePage=following&&active&&!query.trim()&&current>=0?Math.floor(current/50):page;
  const visible=matches.slice(effectivePage*50,effectivePage*50+50);
  useEffect(()=>{if(open&&following&&!query.trim())list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({block:"nearest",behavior:"auto"});},[open,following,query,current]);
  useEffect(()=>setPage(0),[query]);
  return <section className="podcast-transcript-panel">
    <Button variant="ghost" className="podcast-transcript-disclosure" aria-expanded={open} aria-controls={`transcript-${episodeId}`} onClick={()=>setOpen(value=>!value)}>转写 · {open?"收起":"展开"}</Button>
    {open&&<div id={`transcript-${episodeId}`}>
      {busy?<PodcastLoading label="正在读取转写"/>:error?<div role="alert"><p>{error}</p><Button onClick={()=>setRevision(value=>value+1)}>重试转写</Button></div>:document&&<>
        <div className="podcast-episode-filters"><input type="search" aria-label="搜索转写内容" placeholder="搜索转写内容" value={query} onChange={event=>setQuery(event.target.value)}/><label><input type="checkbox" checked={following} onChange={event=>setFollowing(event.target.checked)}/>跟随播放</label></div>
        <p className="podcast-search-page-status" role="status">{matches.length} 段{document.language?` · ${document.language}`:""}{document.stale?" · 显示本地转写缓存":""}</p>
        <ol ref={list} className="podcast-transcript-cues" aria-label="转写段落">{visible.map(({cue,index})=><li key={index} aria-current={current===index?"true":undefined}>
          {cue.startSeconds!==null?<Button variant="ghost" title={`从 ${formatTime(cue.startSeconds)} 播放`} onClick={()=>onPlayAt(cue.startSeconds!)}>{formatTime(cue.startSeconds)}</Button>:<span>文字</span>}
          <p>{cue.speaker&&<strong>{cue.speaker}：</strong>}{cue.text}</p>
        </li>)}</ol>
        {matches.length===0&&<p>没有匹配的转写内容</p>}
        {matches.length>50&&<div className="podcast-search-page-actions"><Button disabled={effectivePage===0} onClick={()=>{setFollowing(false);setPage(effectivePage-1);}}>上一页</Button><span>第 {effectivePage+1} 页</span><Button disabled={(effectivePage+1)*50>=matches.length} onClick={()=>{setFollowing(false);setPage(effectivePage+1);}}>下一页</Button></div>}
      </>}
    </div>}
  </section>;
}
