import assert from "node:assert/strict";
import test from "node:test";
import { mountPodcastHook, runtime, step } from "./helpers/podcastRuntime.mjs";
test("persistent queue entry is handled once in StrictMode and later ordinary navigation survives",async()=>{
  const handled=[];const props={queue:[],autoQueueMode:"off",activeEpisode:null,activeEpisodeId:null,activeProgress:0,activeDuration:0,libraryRevision:0,episodeRequest:null,feedRequest:null,pinnedPodcastFeedIds:new Set(),onEpisodeUpdated(){},queueRequest:1,onQueueRequestHandled:nonce=>handled.push(nonce)};
  const h=await mountPodcastHook(runtime.usePodcastViewModel,props,async command=>{if(command==="podcast_list_feeds")return [];if(command==="podcast_list_home")return {};if(command==="podcast_list_downloads")return {episodes:[],totalCount:0,totalBytes:0,feedCount:0,hasMore:false};if(command==="podcast_refresh_feeds")return {checked:0,failures:[]};return null;});
  try{assert.equal(h.api.screen,"playlist");assert.deepEqual(handled,[1]);assert.equal(h.api.queueFocusRequest,1);await step(()=>h.api.changeRootScreen("library"));await h.render({...props,queueRequest:0});assert.equal(h.api.screen,"library");await h.render({...props,queueRequest:2});assert.equal(h.api.screen,"playlist");assert.deepEqual(handled,[1,2]);}finally{await h.close();}
});
