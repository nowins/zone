import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {deferred,mountPodcastHook,runtime,step,podcastEpisode,podcastFeed} from "./helpers/podcastRuntime.mjs";
const props={queue:[],autoQueueMode:"off",activeEpisode:null,activeEpisodeId:null,activeProgress:0,activeDuration:0,libraryRevision:0,episodeRequest:null,feedRequest:null,pinnedPodcastFeedIds:new Set(),onEpisodeUpdated(){}};
async function mount(invoke,render=()=>null){return mountPodcastHook(runtime.usePodcastViewModel,props,async(command,args)=>{
 if(command==="podcast_list_home")return {};
 if(command==="podcast_refresh_feeds")return {checked:0,failures:[]};
 if(command==="podcast_list_feeds")return [podcastFeed];
 if(command==="podcast_load_discovery_cache")return null;
 return invoke(command,args);
},{},render);}
test("Apple failure can find subscribed shows and explains the limited fallback source",async()=>{
 const h=await mount(async command=>{if(command==="podcast_search_apple"||command==="podcast_browse_discovery")throw Error("offline");return [];});
 try{await step(()=>h.api.repeatPodcastSearch("节目"));assert.equal(h.api.searchState,"ready");assert.equal(h.api.searchResults[0].feedUrl,podcastFeed.feedUrl);assert.match(h.api.notice,/本地节目及榜单/);}finally{await h.close();}
});
test("a superseded catalog search cannot replace the latest search results",async()=>{
 const late=deferred();const newest={id:"latest",title:"最新结果",author:"",feedUrl:"https://example.com/new",genres:[]};
 const h=await mount(async(command,args)=>{if(command==="podcast_search_apple"){if(args.query==="旧查询")throw Error("offline");return [newest];}if(command==="podcast_browse_discovery")return late.promise;return [];});
 try{await step(()=>h.api.repeatPodcastSearch("旧查询"));await step(()=>h.api.repeatPodcastSearch("新查询"));await step(()=>late.resolve({shows:[{...newest,title:"旧查询",rank:1}],source:"xyzrank",fetchedAt:Date.now(),stale:false}));assert.equal(h.api.searchResults[0].id,"latest");}finally{await h.close();}
});
test("local episode browser ignores late pages after a new query and reads native totals",async()=>{
 const late=deferred();const fresh=podcastEpisode("fresh");
 const h=await mount(async(command,args)=>{if(command==="podcast_search_episodes")return args.query==="旧"?late.promise:{episodes:[fresh],total:123,hasMore:true};return [];},vm=>React.createElement(runtime.EpisodeBrowser,{vm,requestedQuery:vm.query}));
 try{await step(()=>h.api.setQuery("旧"));await step(()=>new Promise(resolve=>setTimeout(resolve,230)));await step(()=>h.api.setQuery("新"));await step(()=>new Promise(resolve=>setTimeout(resolve,230)));await step(()=>late.resolve({episodes:[podcastEpisode("stale")],total:1,hasMore:false}));assert.match(document.body.textContent,/共 123 集/);assert.match(document.body.textContent,/fresh/);assert.doesNotMatch(document.body.textContent,/stale/);}finally{await h.close();}
});
