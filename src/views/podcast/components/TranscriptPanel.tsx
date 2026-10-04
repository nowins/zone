import { useEffect, useMemo, useRef, useState } from "react";
import { Select } from "../../../components/Select";
import { CloudTranscriptAction } from "./CloudTranscriptAction";
import { Button } from "../../../components/Button";
import { formatTime } from "../../../utils/music";
import { cancelPodcastRequest, getTranscript, transcriptSources, type TranscriptDocument } from "../api";
import { PodcastLoading } from "./primitives";

export function TranscriptPanel({episodeId,active,progress,revealed=false,onPlayAt}:{episodeId:string;active:boolean;progress:number;revealed?:boolean;onPlayAt:(seconds:number)=>void}) {
  const [open,setOpen]=useState(false);const [document,setDocument]=useState<TranscriptDocument|null>(null);const [error,setError]=useState<string|null>(null);const [busy,setBusy]=useState(false);
  const [variant,setVariant]=useState("source"),[sources,setSources]=useState<string[]>([]);
  const [query,setQuery]=useState("");const [page,setPage]=useState(0);const [following,setFollowing]=useState(true);const [revision,setRevision]=useState(0);const list=useRef<HTMLOListElement>(null);const panel=useRef<HTMLElement>(null);
  useEffect(() => { if (revealed) setOpen(true); }, [revealed]);
  useEffect(()=>{if(!open)return;let disposed=false;setBusy(true);setError(null);setDocument(null);
    void transcriptSources(episodeId).then(value=>{if(!disposed){setSources(value);if(value.length&&!value.includes(variant))setVariant(value[0]);}}).catch(()=>{});
    void getTranscript(episodeId,variant).then(value=>{if(!disposed)setDocument(value);}).catch(reason=>{if(!disposed)setError(String(reason));}).finally(()=>{if(!disposed)setBusy(false);});
    return()=>{disposed=true;void cancelPodcastRequest("transcript").catch(()=>{});};
  },[episodeId,open,revision,variant]);
  const timed=useMemo(()=>document?.cues.map((cue,index)=>({cue,index})).filter(item=>item.cue.startSeconds!==null)??[],[document]);
  let left=0,right=timed.length;while(left<right){const mid=(left+right)>>>1;if(timed[mid].cue.startSeconds!<=progress)left=mid+1;else right=mid;}
  const candidate=active&&left>0?timed[left-1]:null;
  const current=candidate&&(candidate.cue.endSeconds===null||progress<candidate.cue.endSeconds)?candidate.index:-1;
  const matches=useMemo(()=>document?.cues.map((cue,index)=>({cue,index})).filter(({cue})=>`${cue.speaker??""} ${cue.text}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))??[],[document,query]);
  const effectivePage=following&&active&&!query.trim()&&current>=0?Math.floor(current/50):page;
  const visible=matches.slice(effectivePage*50,effectivePage*50+50);
  useEffect(()=>{if(!open||!following||query.trim())return;const focused=window.document.activeElement;
    // Keep automatic following from scrolling away an explicitly focused reader control.
    if(focused&&panel.current?.contains(focused)&&!list.current?.contains(focused))return;
    list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({block:"nearest",behavior:"auto"});},[open,following,query,current]);
  useEffect(()=>setPage(0),[query]);
  return <section ref={panel} className="podcast-transcript-panel">
    <Button variant="ghost" className="podcast-transcript-disclosure" aria-expanded={open} aria-controls={`transcript-${episodeId}`} onClick={()=>setOpen(value=>!value)}>转写 · {open?"收起":"展开"}</Button>
    {open&&<div id={`transcript-${episodeId}`}>
      <div className="podcast-cloud-toolbar">{sources.length>1&&<Select aria-label="转写版本" value={variant} onValueChange={value=>{setVariant(value);setPage(0);setQuery("");}}>{sources.map(source=><option key={source} value={source}>{source==="source"?"节目原文":source==="generated"?"生成原文":"中文翻译"}</option>)}</Select>}<CloudTranscriptAction episodeId={episodeId} source={variant} canTranslate={!busy&&!error&&Boolean(document?.cues.length)} onGenerated={(document,variant)=>{setDocument(document);setVariant(variant);setError(null);setPage(0);setQuery("");setRevision(value=>value+1);}}/></div>
      {busy?<PodcastLoading label="正在读取转写"/>:error?<div role="alert"><p>{error}</p><Button onClick={()=>setRevision(value=>value+1)}>重试转写</Button></div>:document&&<>
        <div className="podcast-episode-filters"><input type="search" aria-label="搜索转写内容" placeholder="搜索转写内容" value={query} onChange={event=>setQuery(event.target.value)}/><label><input type="checkbox" checked={following} onChange={event=>setFollowing(event.target.checked)}/>跟随播放</label></div>
        <p className="podcast-search-page-status" role="status">{matches.length} 段{document.language?` · ${document.language}`:""}{document.stale?" · 显示本地转写缓存":""}</p>
        {active && current >= 0 && (!following || query.trim()) && <Button variant="ghost" onClick={() => { setQuery(""); setPage(Math.floor(current / 50)); setFollowing(true); }}>回到当前段落</Button>}
        <ol ref={list} className="podcast-transcript-cues" tabIndex={0} onWheel={() => { setPage(effectivePage); setFollowing(false); }} onTouchMove={() => { setPage(effectivePage); setFollowing(false); }} onPointerDown={() => { setPage(effectivePage); setFollowing(false); }} onKeyDown={event => { if (["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"," "].includes(event.key)) { setPage(effectivePage); setFollowing(false); } }} aria-label="转写段落">{visible.map(({cue,index})=><li key={index} aria-current={current===index?"true":undefined}>
          {cue.startSeconds!==null?<Button variant="ghost" title={`从 ${formatTime(cue.startSeconds)} 播放`} onClick={()=>onPlayAt(cue.startSeconds!)}>{formatTime(cue.startSeconds)}</Button>:<span>文字</span>}
          <p>{current === index && <span className="podcast-transcript-current-label">当前段落 · </span>}{cue.speaker&&<strong>{cue.speaker}：</strong>}{cue.text}</p>
        </li>)}</ol>
        {matches.length===0&&<p>没有匹配的转写内容</p>}
        {matches.length>50&&<div className="podcast-search-page-actions"><Button disabled={effectivePage===0} onClick={()=>{setFollowing(false);setPage(effectivePage-1);}}>上一页</Button><span>第 {effectivePage+1} 页</span><Button disabled={(effectivePage+1)*50>=matches.length} onClick={()=>{setFollowing(false);setPage(effectivePage+1);}}>下一页</Button></div>}
      </>}
    </div>}
  </section>;
}
