import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../../components/Button";
import { EpisodeRow } from "./EpisodeRows";
import { PodcastEmpty, PodcastLoading } from "./primitives";
import { searchLocalEpisodes, type EpisodeSearchPage } from "../api";
import type { PodcastViewModel } from "../usePodcastViewModel";

const filters = [["all","全部"],["unplayed","未听完"],["in-progress","正在收听"],["unstarted","尚未开始"],["played","已听完"],["downloaded","已下载"],["saved","稍后听"]];
const browsing = new Map<string,{query:string;filter:string;sort:string;offset:number}>();
export function EpisodeBrowser({ vm, feedId, requestedQuery, children, scope, initialFilter="all", initialSort="newest", followedOnly }: {vm:PodcastViewModel;feedId?:string;requestedQuery?:string;children?:ReactNode;scope?:string;initialFilter?:string;initialSort?:string;followedOnly?:boolean}) {
  const key=scope ?? feedId ?? "library";const restored=browsing.get(key);
  const [query,setQuery]=useState(restored?.query ?? "");const [filter,setFilter]=useState(restored?.filter ?? initialFilter);const [sort,setSort]=useState(restored?.sort ?? initialSort);
  const [page,setPage]=useState<EpisodeSearchPage|null>(null);const [offset,setOffset]=useState(restored?.offset ?? 0);const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  const [committedQuery,setCommittedQuery]=useState(query);
  const composing=useRef(false);
  const actualQuery=requestedQuery ?? committedQuery;
  const criteria=JSON.stringify([actualQuery,filter,sort,feedId,followedOnly]);
  const previousCriteria=useRef(criteria);
  const loadedCriteria=useRef<string|null>(null);
  const active=requestedQuery!==undefined ? Boolean(requestedQuery.trim()) : Boolean(scope || feedId || actualQuery.trim() || filter!=="all" || sort!=="newest");
  useEffect(()=>{browsing.set(key,{query:committedQuery,filter,sort,offset});while(browsing.size>100)browsing.delete(browsing.keys().next().value!);},[key,committedQuery,filter,sort,offset]);
  useEffect(()=>{if(previousCriteria.current!==criteria){previousCriteria.current=criteria;setOffset(0);}},[criteria]);
  useEffect(()=>{
    if(!active){setPage(null);return;}
    let disposed=false;setBusy(true);setError(null);
    const requestKey=JSON.stringify([criteria,offset]);if(loadedCriteria.current!==requestKey)setPage(null);
    const timer=window.setTimeout(()=>{void searchLocalEpisodes({feedId,query:actualQuery,filter,sort,offset,limit:50,followedOnly}).then(result=>{if(!disposed){if(offset>0 && offset>=result.total){setOffset(Math.max(0,Math.floor((result.total-1)/50)*50));return;}loadedCriteria.current=requestKey;setPage(result);}}).catch(reason=>{if(!disposed){setError(String(reason));}}).finally(()=>{if(!disposed)setBusy(false);});},200);
    return()=>{disposed=true;window.clearTimeout(timer);};
  },[actualQuery,filter,sort,offset,feedId,active,vm.libraryRevision,followedOnly]);
  return <div className="podcast-episode-browser">
    {requestedQuery===undefined && <div className="podcast-episode-filters">
      <input type="search" value={query} onChange={event=>{setQuery(event.target.value);if(!composing.current)setCommittedQuery(event.target.value);}} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={event=>{composing.current=false;setCommittedQuery(event.currentTarget.value);}} aria-label={feedId?"搜索节目单集":"搜索本地播客资料库"} placeholder={feedId?"搜索单集标题与简介":"搜索本地节目、单集和简介"}/>
      <select aria-label="单集筛选" value={filter} onChange={event=>setFilter(event.target.value)}>{filters.map(([id,title])=><option key={id} value={id}>{title}</option>)}</select>
      <select aria-label="单集排序" value={sort} onChange={event=>setSort(event.target.value)}><option value="newest">最新在前</option><option value="oldest">最早在前</option><option value="title">按标题</option><option value="listened">最近收听</option></select>
    </div>}
    {active ? <section aria-label="本地单集搜索结果" aria-busy={busy}>
      {error?<p role="alert">{error}</p>:null}
      {busy&&!page?<PodcastLoading label="正在搜索本地单集"/>:page?.episodes.length?<>
        <p className="podcast-search-page-status" role="status">本地单集 · 共 {page.total} 集 {busy?"· 更新中 ":""}· 第 {offset+1}–{offset+page.episodes.length} 集</p>
        {page.episodes.map(episode=><EpisodeRow key={episode.id} episode={episode} active={vm.currentEpisodeId===episode.id} isPlaying={vm.currentEpisodeId===episode.id&&vm.isPlaying} downloading={vm.downloadingId===episode.id} showFeed={!feedId}
          onOpen={()=>vm.openEpisodeDetail(episode,feedId?"show":"library")} onPlay={()=>vm.playEpisode(episode)} onDownload={()=>void vm.downloadEpisode(episode)} onContextMenu={event=>vm.showEpisodeMenu(event,episode)}/>)}
        <div className="podcast-search-page-actions"><Button disabled={busy||offset===0} onClick={()=>setOffset(value=>Math.max(0,value-50))}>上一页</Button><Button disabled={busy||!page.hasMore} onClick={()=>setOffset(value=>value+50)}>下一页</Button></div>
      </>:<PodcastEmpty label="没有匹配的本地单集"/>}
    </section>:children}
  </div>;
}
