import test from "node:test";
import assert from "node:assert/strict";
import { PodcastVoiceEnvelope } from "../src/workers/podcastAudio.worklet.js";

function render(level, normalize = true, volume = 1) {
  const processor = new PodcastVoiceEnvelope(), input = new Float32Array(128), output = new Float32Array(128);
  for (let i=0;i<input.length;i++) input[i]=Math.sin(i*0.2)*level*volume;
  let state; for(let n=0;n<1500;n++) state=processor.process([input],[output],128/48000,normalize,volume);
  return { state, output, input, processor };
}
test("voice levelling boosts quiet speech, reduces loud speech and respects user volume",()=>{
  const quiet=render(0.04), loud=render(0.6), lowerVolume=render(0.04,true,0.2);
  assert.ok(quiet.state.gain>2.8);assert.ok(loud.state.gain<0.3);
  assert.ok(Math.abs(quiet.state.gain-lowerVolume.state.gain)<0.001);
  assert.ok(Math.max(...lowerVolume.output)<Math.max(...quiet.output)*0.21);
});
test("silence gates boost and acceleration, bypass is exact and reset discards stale silence",()=>{
  const silence=render(0);assert.equal(silence.state.silent,true);assert.equal(silence.state.gain,1);
  const muted=render(0.1,true,0);assert.equal(muted.state.silent,false);
  const bypass=render(0.4,false);assert.deepEqual(bypass.output,bypass.input);
  const output=new Float32Array(128);silence.processor.reset();
  assert.equal(silence.processor.process([new Float32Array(128)],[output],128/48000,true).silent,false);
  const spike=new Float32Array(128).fill(10);silence.processor.process([spike],[output],128/48000,true);
  assert.ok(output.every(sample=>Math.abs(sample)<=0.981));
});
