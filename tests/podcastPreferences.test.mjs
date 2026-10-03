import assert from "node:assert/strict";
import test from "node:test";
import {effectivePodcastPreferences,podcastIntroPosition,podcastOutroReached} from "../.tmp/visualizer-tests/utils/podcastPreferences.js";
test("show preferences inherit defaults until explicitly customized",()=>{
 assert.equal(effectivePodcastPreferences({playbackRate:1.5,backwardSeconds:10},{playbackRate:2}).playbackRate,1.5);
 assert.equal(effectivePodcastPreferences({playbackRate:1.5,backwardSeconds:10},{inheritPlayback:false,playbackRate:2,backwardSeconds:20}).backwardSeconds,20);
});
test("intro skipping respects explicit timestamps and never skips a shorter episode",()=>{
 assert.equal(podcastIntroPosition(0,600,30,20,false),30);
 assert.equal(podcastIntroPosition(80,600,30,20,false),80);
 assert.equal(podcastIntroPosition(5,600,30,20,true),5);
 assert.equal(podcastIntroPosition(0,45,30,20,false),0);
 assert.equal(podcastOutroReached(579,600,30,20),false);
 assert.equal(podcastOutroReached(580,600,30,20),true);
 assert.equal(podcastOutroReached(40,45,30,20),false);
});
