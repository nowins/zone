import assert from "node:assert/strict";
import test from "node:test";
import {createPodcastListeningMeter} from "../.tmp/visualizer-tests/utils/podcastListeningStats.js";
test("listening measures actual wall time at all rates and excludes seek, pause, stalls, sleep and music",()=>{
  const meter=createPodcastListeningMeter();let clockMs=0,position=0;
  const sample=(extra={})=>meter.sample({episodeId:"podcast",clockMs,position,rate:1.5,playing:true,seeking:false,...extra});
  sample();for(let i=0;i<4;i++){clockMs+=500;position+=.75;sample();}
  assert.equal(meter.drain()[0].seconds,2);
  clockMs+=500;position+=100;sample({seeking:true});clockMs+=500;sample({seeking:false});
  clockMs+=500;sample({playing:false});clockMs+=10000;sample({playing:false});clockMs+=500;sample();
  clockMs+=500;sample();clockMs+=100000;position+=1;sample();
  clockMs+=500;position+=1;sample({episodeId:null});clockMs+=500;position+=1;sample({episodeId:null});
  assert.deepEqual(meter.drain(),[]);
  sample({rate:3});clockMs+=1000;position+=3;sample({rate:3});assert.equal(meter.drain()[0].seconds,1);
});
