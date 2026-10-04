import { createElement, useMemo, useState, type ReactNode, type MouseEvent } from "react";
import { Button } from "../../../components/Button";
import { parsePodcastNotes, podcastTimecodeSeconds, safePodcastLink, type NoteNode } from "../../../utils/podcastNotes.js";
import { openPodcastLink } from "../api";

export function PodcastExternalLink({href,children}:{href:string;children:ReactNode}) {
  const [error,setError]=useState(false);const safe=safePodcastLink(href);
  if(!safe)return <>{children}</>;
  async function open(event:MouseEvent<HTMLAnchorElement>){event.preventDefault();if(event.type==="auxclick"&&event.button!==1)return;setError(false);try{await openPodcastLink(safe!);}catch{setError(true);}}
  return <><a href={safe} title={safe} onClick={event=>void open(event)} onAuxClick={event=>void open(event)}>{children}</a>{error&&<span role="alert"> 无法打开链接</span>}</>;
}
export function PodcastNotes({source,base,duration,onPlayAt,interactive=true}:{source:string;base?:string;duration?:number|null;onPlayAt?:(seconds:number)=>void;interactive?:boolean}) {
  const nodes=useMemo(()=>parsePodcastNotes(source,base),[source,base]);
  function timecodes(text:string,key:string) {
    const result:ReactNode[]=[];let offset=0;
    for(const match of text.matchAll(/(^|[^\d:])((?:\d{1,3}:)?\d{1,2}:\d{2})(?![\d:])/g)) {
      const start=match.index!+match[1].length;result.push(text.slice(offset,start));
      const seconds=podcastTimecodeSeconds(match[2]);
      if(interactive&&onPlayAt&&seconds!==null&&(!duration||seconds<duration))result.push(<Button key={`${key}-${start}`} variant="ghost" className="podcast-note-timecode" title={`从 ${match[2]} 播放`} onClick={()=>onPlayAt(seconds)}>{match[2]}</Button>);else result.push(match[2]);
      offset=start+match[2].length;
    }result.push(text.slice(offset));return result;
  }
  function render(list:NoteNode[],key="note",inLink=false):ReactNode[] {return list.map((node,index)=>{
    const id=`${key}-${index}`;if(node.type==="text")return <span key={id}>{inLink?node.text:timecodes(node.text,id)}</span>;
    const children=render(node.children,id,inLink||Boolean(node.href));return node.href&&interactive?<PodcastExternalLink key={id} href={node.href}>{children}</PodcastExternalLink>:createElement(node.tag,{key:id},node.tag==="br"?undefined:children);
  });}
  return <div className="podcast-notes">{render(nodes)}</div>;
}
