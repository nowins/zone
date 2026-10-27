import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
const dom = new JSDOM('<div id="root"></div>', {url:'http://localhost', pretendToBeVisual:true});
for (const key of ['window','document','HTMLElement','HTMLButtonElement','Element']) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
window.matchMedia = () => ({matches:true, addEventListener(){}, removeEventListener(){}});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const {createRoot} = await import('react-dom/client');
const methods = ['cancelPodcastRequest','generateTranscript','generateLocalTranscript','getCloudSettings','getLocalTranscriptionStatus','getEpisodeDetail','importLocalModel','openPodcastLink','saveTranscriptionSettings'];
await build({stdin:{contents:'export {CloudTranscriptAction} from "./src/views/podcast/components/CloudTranscriptAction"; export {LocalTranscriptionSettings} from "./src/views/podcast/components/LocalTranscriptionSettings";',resolveDir:process.cwd(),loader:'tsx'},outfile:'.tmp/local-transcription-runtime/view.mjs',bundle:true,packages:'external',format:'esm',platform:'browser',logLevel:'silent',plugins:[{name:'controlled-native-boundary',setup(b){
  b.onLoad({filter:/[\\/]podcast[\\/]api\.ts$/},()=>({contents:methods.map(name=>`export const ${name}=(...args)=>globalThis.nativeData.${name}(...args);`).join('\n'),loader:'ts'}));
  b.onResolve({filter:/^@tauri-apps\/api\/event$/},()=>({path:'event',namespace:'events'}));
  b.onLoad({filter:/.*/,namespace:'events'},()=>({contents:'export async function listen(name,handler){globalThis.events.set(name,handler);return ()=>{if(globalThis.events.get(name)===handler)globalThis.events.delete(name)}}',loader:'js'}));
}}]});
const {CloudTranscriptAction,LocalTranscriptionSettings} = await import('../.tmp/local-transcription-runtime/view.mjs');
const settings = {backend:'local',modelId:'base-q5_1',language:'auto',threads:4};
const model = {id:'base-q5_1',filename:'ggml-base-q5_1.bin',bytes:59707625,sha256:'a'.repeat(64),installed:true,sourceUrl:'https://huggingface.co/ggerganov/whisper.cpp/resolve/pinned/ggml-base-q5_1.bin'};
const status = {settings,models:[model],engineReady:true,engineError:null,modelDirectory:'C:\\Isolated\\models',availableBytes:1024**3};
const documentValue = {episodeId:'one',cues:[{startSeconds:1,endSeconds:2,text:'hello'}],language:null,stale:false};
let calls;
async function mount(t, Component=CloudTranscriptAction, overrides={}) {
  calls=[];globalThis.events=new Map();
  globalThis.nativeData=Object.fromEntries(methods.map(name=>[name,async(...args)=>{calls.push([name,...args]);return null;}]));
  nativeData.getLocalTranscriptionStatus=async()=>structuredClone(status);
  nativeData.getCloudSettings=async()=>({baseUrl:'https://example.com/v1',hasKey:true,translationModel:'translation',transcriptionModel:'asr'});
  nativeData.getEpisodeDetail=async()=>({episode:{title:'合成播客',durationSeconds:75,localPath:'C:\\Isolated\\audio.wav'}});
  Object.assign(nativeData,overrides);
  const received=[];
  const root=createRoot(document.getElementById('root'));
  const props={episodeId:'one',source:'generated',canTranslate:true,onGenerated:(...args)=>received.push(args)};
  await act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(Component,props))));
  t.after(async()=>{await act(()=>root.unmount());});
  return {root,received,props};
}
const button=text=>[...document.querySelectorAll('button')].find(n=>n.textContent===text);
const click=async text=>act(async()=>button(text).click());
const settle=async()=>act(()=>new Promise(resolve=>setTimeout(resolve,30)));

test('local confirmation never sends cloud audio, reports progress and routes cancellation',async t=>{
  let reject;
  const {received}=await mount(t,CloudTranscriptAction,{generateLocalTranscript:(...args)=>{calls.push(['generateLocalTranscript',...args]);return new Promise((_,no)=>{reject=no;});}});
  await click('生成转写');
  assert.match(document.querySelector('[role="dialog"]').textContent,/不上传音频/);
  assert.equal(button('确认上传并处理'),undefined);
  await click('开始本地转写');
  assert.deepEqual(calls.find(c=>c[0]==='generateLocalTranscript'),['generateLocalTranscript','one',settings]);
  await act(()=>events.get('podcast-local-progress')({payload:{episodeId:'one',processedSeconds:45}}));
  assert.match(document.querySelector('[role="dialog"]').textContent,/已处理/);
  await click('取消处理');
  assert.ok(calls.some(c=>c[0]==='cancelPodcastRequest'&&c[1]==='local-transcript'));
  await act(async()=>{reject(Error('已取消本地转写，已有字幕保持不变'));await Promise.resolve();});
  assert.equal(received.length,0);
  assert.equal(calls.filter(c=>c[0]==='generateTranscript').length,0);
  assert.match(document.querySelector('[role="alert"]').textContent,/已有字幕保持不变/);
});
test('Chinese translation still requires explicit cloud confirmation with local transcription selected',async t=>{
  const {received}=await mount(t,CloudTranscriptAction,{generateTranscript:async(...args)=>{calls.push(['generateTranscript',...args]);return documentValue;}});
  await click('翻译为中文 · 云端');
  assert.equal(button('开始本地转写'),undefined);
  assert.match(document.querySelector('[role="dialog"]').textContent,/上传当前选择的完整转写文字/);
  assert.equal(calls.filter(c=>c[0]==='generateTranscript').length,0);
  await click('确认上传并处理');
  assert.deepEqual(calls.find(c=>c[0]==='generateTranscript'),['generateTranscript','one','translate','generated','https://example.com/v1']);
  assert.equal(received[0][1],'translated');
});
test('cloud transcription remains usable with no installed local engine or model',async t=>{
  const {received}=await mount(t,CloudTranscriptAction,{
    getLocalTranscriptionStatus:async()=>({...status,settings:{...settings,backend:'cloud'},engineReady:false,models:[{...model,installed:false}]}),
    generateTranscript:async(...args)=>{calls.push(['generateTranscript',...args]);return documentValue;},
  });
  await click('生成转写');assert.equal(button('确认上传并处理').disabled,false);
  await click('确认上传并处理');assert.equal(received[0][1],'generated');
  assert.equal(calls.find(c=>c[0]==='generateTranscript')[2],'transcribe');
});
test('a result arriving after an episode change cannot replace the new episode document',async t=>{
  let finish;
  const {root,received,props}=await mount(t,CloudTranscriptAction,{generateLocalTranscript:()=>new Promise(yes=>{finish=yes;})});
  await click('生成转写');await click('开始本地转写');
  await act(()=>root.render(React.createElement(CloudTranscriptAction,{...props,episodeId:'two'})));
  await act(()=>finish(documentValue));assert.equal(received.length,0);
  assert.equal(document.querySelector('[role="dialog"]'),null);
  assert.ok(calls.some(c=>c[0]==='cancelPodcastRequest'&&c[1]==='local-transcript'));
});
test('settings require separate download and import actions and retain explicit backend saving',async t=>{
  await mount(t,LocalTranscriptionSettings,{importLocalModel:async(...args)=>{calls.push(['importLocalModel',...args]);return status;}});
  assert.equal(calls.filter(c=>c[0]==='openPodcastLink'||c[0]==='importLocalModel').length,0);
  await click('打开官方模型下载');assert.equal(calls.find(c=>c[0]==='openPodcastLink')[1],model.sourceUrl);
  await click('选择文件并校验导入');assert.deepEqual(calls.find(c=>c[0]==='importLocalModel'),['importLocalModel','base-q5_1']);
  await click('保存转写方式');assert.deepEqual(calls.find(c=>c[0]==='saveTranscriptionSettings'),['saveTranscriptionSettings',settings]);
  await settle();assert.match(document.body.textContent,/中文翻译仍需单独确认云端处理/);
});
test.after(()=>dom.window.close());
