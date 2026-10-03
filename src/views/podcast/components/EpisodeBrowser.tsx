import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../../../components/Button";
import { EpisodeRow } from "./EpisodeRows";
import { PodcastEmpty, PodcastLoading } from "./primitives";
import { searchLocalEpisodes, type EpisodeSearchPage } from "../api";
import type { PodcastViewModel } from "../usePodcastViewModel";

const filters = [["all","全部"],["unplayed","未听完"],["played","已听完"],["downloaded","已下载"],["saved","稍后听"]];
const browsing = new Map<string,{query:string;filter:string;sort:string}>();
export function EpisodeBrowser({ vm, feedId, requestedQuery, children }: {vm:PodcastViewModel;feedId?:string;requestedQuery?:string;children?:ReactNode}) {
  const key=feedId ?? "library";const restored=browsing.get(key);
  const [query,setQuery]=useState(restored?.query ?? "");const [filter,setFilter]=useState(restored?.filter ?? "all");const [sort,setSort]=useState(restored?.sort ?? "newest");
  const [page,setPage]=useState<EpisodeSearchPage|null>(null);const [offset,setOffset]=useState(0);const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  const actualQuery=requestedQuery ?? query;
  const active=requestedQuery!==undefined ? Boolean(requestedQuery.trim()) : Boolean(feedId || actualQuery.trim() || filter!=="all" || sort!=="newest");
  useEffect(()=>{browsing.set(key,{query,filter,sort});while(browsing.size>100)browsing.delete(browsing.keys().next().value!);},[key,query,filter,sort]);
  useEffect(()=>{setOffset(0);},[actualQuery,filter,sort,feedId]);
  useEffect(()=>{
    if(!active){setPage(null);return;}
    let disposed=false;setBusy(true);setError(null);
    const timer=window.setTimeout(()=>{void searchLocalEpisodes({feedId,query:actualQuery,filter,sort,offset,limit:50}).then(result=>{if(!disposed)setPage(result);}).catch(reason=>{if(!disposed){setPage(null);setError(String(reason));}}).finally(()=>{if(!disposed)setBusy(false);});},200);
    return()=>{disposed=true;window.clearTimeout(timer);};
  },[actualQuery,filter,sort,offset,feedId,active,vm.libraryRevision]);
  return <div className="podcast-episode-browser">
    {requestedQuery===undefined && <div className="podcast-episode-filters">
      <input type="search" value={query} onChange={event=>setQuery(event.target.value)} aria-label={feedId?"搜索节目单集":"搜索本地播客资料库"} placeholder={feedId?"搜索单集标题与简介":"搜索本地节目、单集和简介"}/>
      <select aria-label="单集筛选" value={filter} onChange={event=>setFilter(event.target.value)}>{filters.map(([id,title])=><option key={id} value={id}>{title}</option>)}</select>
      <select aria-label="单集排序" value={sort} onChange={event=>setSort(event.target.value)}><option value="newest">最新在前</option><option value="oldest">最早在前</option><option value="title">按标题</option></select>
    </div>}
    {active ? <section aria-label="本地单集搜索结果" aria-busy={busy}>
      {busy?<PodcastLoading label="正在搜索本地单集"/>:error?<p role="alert">{error}</p>:page?.episodes.length?<>
        <p className="podcast-search-page-status" role="status">本地单集 · 共 {page.total} 集 · 第 {offset+1}–{offset+page.episodes.length} 集</p>
        {page.episodes.map(episode=><EpisodeRow key={episode.id} episode={episode} active={vm.currentEpisodeId===episode.id} isPlaying={vm.currentEpisodeId===episode.id&&vm.isPlaying} downloading={vm.downloadingId===episode.id} showFeed={!feedId}
          onOpen={()=>vm.openEpisodeDetail(episode,feedId?"show":"library")} onPlay={()=>vm.playEpisode(episode)} onDownload={()=>void vm.downloadEpisode(episode)} onContextMenu={event=>vm.showEpisodeMenu(event,episode)}/>)}
        <div className="podcast-search-page-actions"><Button disabled={offset===0} onClick={()=>setOffset(value=>Math.max(0,value-50))}>上一页</Button><Button disabled={!page.hasMore} onClick={()=>setOffset(value=>value+50)}>下一页</Button></div>
      </>:<PodcastEmpty label="没有匹配的本地单集"/>}
    </section>:children}
  </div>;
}
