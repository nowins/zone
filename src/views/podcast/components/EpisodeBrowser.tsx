import { Select } from "../../../components/Select";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../../components/Button";
import { EpisodeRow } from "./EpisodeRows";
import { PodcastEmpty, PodcastLoading } from "./primitives";
import { searchLocalEpisodes, type EpisodeSearchPage } from "../api";
import type { PodcastViewModel } from "../usePodcastViewModel";
import { formatTime } from "../../../utils/music";

const filters = [["all","全部"],["unplayed","未听完"],["in-progress","正在收听"],["unstarted","尚未开始"],["played","已听完"],["downloaded","已下载"],["saved","稍后听"],["history","收听历史"]];
const browsing = new Map<string,{query:string;filter:string;sort:string;offset:number;season?:string;episodeType?:string}>();
export function EpisodeBrowser({ vm, feedId, requestedQuery, children, scope, initialFilter="all", initialSort="newest", followedOnly }: {vm:PodcastViewModel;feedId?:string;requestedQuery?:string;children?:ReactNode;scope?:string;initialFilter?:string;initialSort?:string;followedOnly?:boolean}) {
  const key=scope ?? feedId ?? "library";const restored=browsing.get(key);
  const [query,setQuery]=useState(restored?.query ?? "");const [filter,setFilter]=useState(restored?.filter ?? initialFilter);const [sort,setSort]=useState(restored?.sort ?? initialSort);
  const [season,setSeason]=useState(restored?.season ?? "all");const [episodeType,setEpisodeType]=useState(restored?.episodeType ?? "all");
  const [series,setSeries]=useState<EpisodeSearchPage["series"]>(null);
  const [page,setPage]=useState<EpisodeSearchPage|null>(null);const [offset,setOffset]=useState(restored?.offset ?? 0);const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  const [committedQuery,setCommittedQuery]=useState(query);
  const composing=useRef(false);
  const actualQuery=requestedQuery ?? committedQuery;
  const criteria=JSON.stringify([actualQuery,filter,sort,feedId,followedOnly,season,episodeType]);
  const previousCriteria=useRef(criteria);
  const loadedCriteria=useRef<string|null>(null);
  const active=requestedQuery!==undefined ? Boolean(requestedQuery.trim()) : Boolean(scope || feedId || actualQuery.trim() || filter!=="all" || sort!=="newest");
  const pending=active&&!page&&!error;
  useEffect(()=>{browsing.set(key,{query:committedQuery,filter,sort,offset,season,episodeType});while(browsing.size>100)browsing.delete(browsing.keys().next().value!);},[key,committedQuery,filter,sort,offset,season,episodeType]);
  useEffect(()=>{if(previousCriteria.current!==criteria){previousCriteria.current=criteria;setOffset(0);}},[criteria]);
  useEffect(()=>{
    if(!active){setPage(null);return;}
    let disposed=false;setBusy(true);setError(null);
    const requestKey=JSON.stringify([criteria,offset]);if(loadedCriteria.current!==requestKey)setPage(null);
    const timer=window.setTimeout(()=>{void searchLocalEpisodes({feedId,query:actualQuery,filter,sort,offset,limit:50,followedOnly,season:season==="all"?undefined:Number(season),episodeType:episodeType==="all"?undefined:episodeType}).then(result=>{if(!disposed){if(offset>0 && offset>=result.total){setOffset(Math.max(0,Math.floor((result.total-1)/50)*50));return;}loadedCriteria.current=requestKey;setPage(result);setSeries(result.series);}}).catch(reason=>{if(!disposed){setError(String(reason));}}).finally(()=>{if(!disposed)setBusy(false);});},200);
    return()=>{disposed=true;window.clearTimeout(timer);};
  },[actualQuery,filter,sort,offset,feedId,active,vm.libraryRevision,followedOnly,season,episodeType]);
  return <div className="podcast-episode-browser">
    {requestedQuery===undefined && <div className="podcast-episode-filters">
      <input type="search" value={query} onChange={event=>{setQuery(event.target.value);if(!composing.current)setCommittedQuery(event.target.value);}} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={event=>{composing.current=false;setCommittedQuery(event.currentTarget.value);}} aria-label={feedId?"搜索节目单集":"搜索本地播客资料库"} placeholder={feedId?"搜索标题、简介、已缓存转写与书签":"搜索节目、单集、已缓存转写与书签"}/>
      <Select aria-label="单集筛选" value={filter} onValueChange={value=>setFilter(value)}>{filters.map(([id,title])=><option key={id} value={id}>{title}</option>)}</Select>
      <Select aria-label="单集排序" value={sort} onValueChange={value=>setSort(value)}><option value="newest">最新在前</option><option value="oldest">最早在前</option><option value="title">按标题</option><option value="listened">最近收听</option>{series?.numbered && <option value="series">按季集顺序</option>}</Select>
      {Boolean(series?.seasons.length) && <Select aria-label="按季筛选" value={season} onValueChange={setSeason}><option value="all">所有季</option>{series?.seasons.map(value=><option key={value} value={String(value)}>第 {value} 季</option>)}</Select>}
      {series?.types.some(type=>type!=="full") && <Select aria-label="单集类型" value={episodeType} onValueChange={setEpisodeType}><option value="all">所有类型</option>{series.types.map(type=><option key={type} value={type}>{type==="trailer"?"预告":type==="bonus"?"加更":"正片"}</option>)}</Select>}
    </div>}
    {active ? <section className="podcast-episode-results" aria-label="本地单集搜索结果" aria-busy={busy||pending} data-browse-pending={pending||undefined}>
      {error?<p role="alert">{error}</p>:null}
      {pending?<PodcastLoading label="正在搜索本地单集"/>:page?.episodes.length?<>
        <p className="podcast-search-page-status" role="status">本地单集 · 共 {page.total} 集 {busy?"· 更新中 ":""}· 第 {offset+1}–{offset+page.episodes.length} 集</p>
        {page.episodes.map(episode=><div key={episode.id}><EpisodeRow episode={episode} active={vm.currentEpisodeId===episode.id} isPlaying={vm.currentEpisodeId===episode.id&&vm.isPlaying} downloading={vm.downloadingId===episode.id} showFeed={!feedId}
          onOpen={()=>vm.openEpisodeDetail(episode,feedId?"show":"library")} onPlay={()=>vm.playEpisode(episode)} onDownload={()=>void vm.downloadEpisode(episode)} onContextMenu={event=>vm.showEpisodeMenu(event,episode)}/>
          {(page.matches??[]).filter(hit=>hit.episodeId===episode.id).map((hit,index)=><div className="podcast-search-content-hit" key={index}>
            <span>{hit.kind==="bookmark"?"书签":"已缓存转写"}</span>
            <Button variant="ghost" aria-label={`${episode.title} · ${hit.positionSeconds===null?"查看内容":"从 "+formatTime(hit.positionSeconds)+" 播放"}`}
              onClick={()=>hit.positionSeconds===null?vm.openEpisodeDetail(episode,feedId?"show":"library"):vm.playEpisodeAt(episode,hit.positionSeconds)}>{hit.positionSeconds===null?"查看内容":formatTime(hit.positionSeconds)}</Button>
            <p>{hit.text}</p>
          </div>)}
        </div>)}
        <div className="podcast-search-page-actions"><Button disabled={busy||offset===0} onClick={()=>setOffset(value=>Math.max(0,value-50))}>上一页</Button><Button disabled={busy||!page.hasMore} onClick={()=>setOffset(value=>value+50)}>下一页</Button></div>
      </>:<PodcastEmpty label="没有匹配的本地单集"/>}
    </section>:children}
  </div>;
}
