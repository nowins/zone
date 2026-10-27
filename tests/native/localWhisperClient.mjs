import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync,execFile} from 'node:child_process';
import {copyFile,readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';

export async function testLocalWhisperClient({root,report,dataDirectory,manifest,executable,invoke,script,command,click,clickText,until,screenshot,ownedProcesses,restartAfterCrash,record,backendOnly=false}) {
  assert.match(manifest.identifier,/^com\.zone\.player\.ci\.run-/);
  assert.equal(resolve(dataDirectory),resolve(process.env.APPDATA,manifest.identifier));
  const fixture=join(root,'.tmp/whisper');
  const marker=JSON.parse((await readFile(join(fixture,'synthetic-fixtures.json'),'utf8')).replace(/^\uFEFF/,''));
  assert.equal(marker.source,'Windows SpeechSynthesizer');assert.equal(marker.userAudio,false);
  const feed='d'.repeat(64),episode='e'.repeat(64),enclosure='https://example.com/zone-synthetic-local.wav';
  const audio=join(dataDirectory,'podcast-downloads',`${episode}.wav`);
  await copyFile(join(fixture,'english.wav'),audio);
  const sourceHash=createHash('sha256').update(await readFile(audio)).digest('hex');
  const database=new DatabaseSync(join(dataDirectory,'zone.sqlite'));
  database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
  const id=origin=>createHash('sha256').update(`cloud-transcript\0${episode}\0${origin}`).digest('hex');
  database.prepare('INSERT INTO podcast_feeds(id,feed_url,title,author,last_fetched_at,last_checked_at,subscribed,subscribed_at) VALUES(?,?,?,?,?,?,1,?)').run(feed,'https://example.com/zone-synthetic-feed.xml','本地转写验收','合成测试素材',Date.now(),Date.now(),Date.now());
  database.prepare('INSERT INTO podcast_episodes(id,feed_id,identity_key,title,description,duration_seconds,enclosure_url,enclosure_type,first_seen_at) VALUES(?,?,?,?,?,10,?,?,?)').run(episode,feed,'synthetic-local','本地转写合成单集','仅使用 Windows 合成语音，不含用户音频。',enclosure,'audio/wav',Date.now());
  database.prepare("INSERT INTO podcast_downloads(episode_id,local_path,state,downloaded_bytes,total_bytes,updated_at) VALUES(?,?,'downloaded',?,?,?)").run(episode,audio,(await stat(audio)).size,(await stat(audio)).size,Date.now());
  for(const origin of ['generated','translated']) {
    database.prepare("INSERT INTO podcast_episode_resources(id,episode_id,kind,source_kind,mime_type,origin,enclosure_binding,fetched_at) VALUES(?,?,'transcript','podcast-transcript','application/json',?,?,?)").run(id(origin),episode,origin,enclosure,Date.now());
    database.prepare('INSERT INTO podcast_transcript_cues(resource_id,ordinal,start_ms,end_ms,text) VALUES(?,0,0,1000,?)').run(id(origin),`原有字幕-${origin}`);
  }
  const snapshot=()=>database.prepare('SELECT r.origin,c.ordinal,c.start_ms,c.end_ms,c.text FROM podcast_episode_resources r JOIN podcast_transcript_cues c ON c.resource_id=r.id WHERE r.episode_id=? ORDER BY r.origin,c.ordinal').all(episode);
  const original=snapshot();
  const local=await invoke('podcast_local_transcription_status');
  assert.equal(local.engineReady,true,local.engineError);
  assert.equal(resolve(local.modelDirectory),resolve(dataDirectory,'podcast-models'));
  await copyFile(join(fixture,'ggml-base-q5_1.bin'),join(local.modelDirectory,'ggml-base-q5_1.bin'));
  const engine=join(resolve(executable,'..'),'whisper','zone-whisper.exe');
  const normalPath=value=>(value.startsWith('\\\\?\\')?value.slice(4):value).replaceAll('/','\\').toLowerCase();
  const engineParents=new Set();
  function enginePids(){
    for(const pid of ownedProcesses())engineParents.add(pid);
    const value=spawnSync('powershell.exe',['-NoProfile','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name='zone-whisper.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath) | ConvertTo-Json -Compress"],{windowsHide:true,encoding:'utf8',timeout:10000});
    if(value.status!==0)throw Error(value.stderr);const parsed=value.stdout.trim()?JSON.parse(value.stdout):[];const rows=Array.isArray(parsed)?parsed:[parsed];
    return rows.filter(p=>engineParents.has(p.ParentProcessId)&&p.ExecutablePath&&normalPath(p.ExecutablePath)===normalPath(engine)).map(p=>p.ProcessId);
  }
  const resize=async(width,height)=>{
    const pids=ownedProcesses();assert.equal(pids.length,1);
    await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'tests/native/setBaselineWindow.ps1'),'-RootPid',String(pids[0]),'-ExpectedExecutable',executable,'-Identifier',manifest.identifier,'-Width',String(width),'-Height',String(height)],{windowsHide:true,timeout:30000});
    await until(()=>script((w,h)=>innerWidth===w&&innerHeight===h,width,height),'local native viewport');
  };
  const select=async(label,value)=>{await click('css selector',`[role="combobox"][aria-label="${label}"]`);await click('css selector',`[role="option"][data-value="${value}"]`);};
  const plainRequest=async(expected,requestId)=>invoke('podcast_generate_local_transcript',{episodeId:episode,expectedSettings:expected,requestId});
  const openReader=async()=>{await clickText('//nav[@aria-label="主要导航"]','播客');await clickText('//nav[@aria-label="播客分区"]','资料库');await click('css selector','.podcast-library-show-open');await click('css selector',`[data-podcast-episode="${episode}"] .podcast-episode-open`);await clickText('//div[@aria-label="单集内容"]','转写');};
  try {
    await click('css selector','.titlebar-settings');await clickText('//nav[@aria-label="设置分区"]','播客');await clickText('//div[@aria-label="设置分类"]','转写服务');
    await until(()=>script(()=>Boolean(document.querySelector('[aria-label="转写方式"]'))),'local settings loaded');
    await select('转写方式','local');await clickText('//*','保存转写方式');
    const settings={backend:'local',modelId:'base-q5_1',language:'auto',threads:4};
    await until(async()=>{const value=(await invoke('podcast_local_transcription_status')).settings;return Object.entries(settings).every(([key,item])=>value[key]===item);},'saved native local selection');
    const nativeViewports=backendOnly?[[1180,760]]:[[1180,760],[920,620]];
    for(const [width,height] of nativeViewports) {
      await resize(width,height);
      await script(()=>{document.querySelector('.settings-content:not([hidden])').scrollTop=0;});
      const bounds=await script(()=>{const e=document.querySelector('.podcast-local-settings');const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,text:e.textContent,overflow:e.scrollWidth>e.clientWidth};});
      assert.ok(bounds.left>=0&&bounds.right<=width&&!bounds.overflow);assert.match(bounds.text,/不上传音频/);assert.match(bounds.text,/中文翻译仍需/);
      await screenshot(`local-settings-${width}x${height}`);
    }
    if(backendOnly){
      const dpr=await script(()=>devicePixelRatio);
      await command('POST','/ms/cdp/execute',{cmd:'Emulation.setDeviceMetricsOverride',params:{width:920,height:620,deviceScaleFactor:dpr,mobile:false}});
      await until(()=>script(()=>innerWidth===920&&innerHeight===620),'explicit responsive-layout emulation');
      const overflow=await script(()=>{const e=document.querySelector('.podcast-local-settings');return e.scrollWidth>e.clientWidth;});assert.equal(overflow,false);
      await screenshot('local-settings-920x620-emulated');
      await command('POST','/ms/cdp/execute',{cmd:'Emulation.clearDeviceMetricsOverride',params:{}});
      await until(()=>script(()=>innerWidth===1180&&innerHeight===760),'restore real viewport after emulation');
    }
    await record(backendOnly?'本地设置真实1180×760及明确标注的920×620布局仿真通过；原生小窗口尺寸同步仍未验收':'本地设置在两种真实窗口尺寸可用，模型在独立用户数据目录，云端翻译标注可见');
    await command('POST','/ms/cdp/execute',{cmd:'Emulation.setEmulatedMedia',params:{features:[{name:'prefers-reduced-motion',value:'reduce'}]}});
    await until(()=>script(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),'local reduced motion');
    await openReader();
    await until(()=>script(()=>document.querySelector('.podcast-transcript-cues')?.textContent.includes('原有字幕-generated')),'old native transcript rendered');
    await clickText('//*','生成转写');await until(()=>script(()=>document.querySelector('[role="dialog"]')?.textContent.includes('本地 CPU 处理')),'local confirmation');
    assert.equal(await script(()=>[...document.querySelectorAll('[role="dialog"] button')].some(n=>n.textContent==='确认上传并处理')),false);
    assert.equal(await script(()=>document.querySelector('[role="dialog"]').contains(document.activeElement)),true);
    await screenshot('local-confirm');
    await clickText('//*','开始本地转写');await until(()=>enginePids().length===1,'actual engine started');
    await clickText('//*','取消处理');await until(()=>script(()=>document.querySelector('[role="dialog"]')?.textContent.includes('已取消')),'local cancellation response');
    await until(()=>enginePids().length===0,'cancelled child reaped');assert.deepEqual(snapshot(),original);
    assert.equal((await readFile(join(dataDirectory,'podcast-models','ggml-base-q5_1.bin'))).length,59707625);
    await screenshot('local-cancel-preserves-old');
    await script(()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
    await until(()=>script(()=>!document.querySelector('[role="dialog"]')),'Escape closes cancelled dialog');
    assert.equal(await script(()=>document.activeElement?.textContent),'生成转写');
    await record('真实界面启动 CPU 引擎、取消并回收子进程，原文和中文翻译均完整保留，Escape 恢复入口焦点');
    const modelFile=join(local.modelDirectory,'ggml-base-q5_1.bin');const damaged=await readFile(modelFile);damaged[0]^=1;await writeFile(modelFile,damaged);
    await assert.rejects(()=>plainRequest(settings,'local-model-corruption'),/SHA-256/);assert.deepEqual(snapshot(),original);
    await copyFile(join(fixture,'ggml-base-q5_1.bin'),modelFile);
    database.exec("CREATE TRIGGER local_test_fail BEFORE INSERT ON podcast_transcript_cues WHEN NEW.text NOT LIKE '原有字幕-%' BEGIN SELECT RAISE(ABORT,'local fixture write failure'); END;");
    try{await assert.rejects(()=>plainRequest(settings,'local-atomic-failure'),/local fixture write failure/);assert.deepEqual(snapshot(),original);}finally{database.exec('DROP TRIGGER local_test_fail');}
    await record('真实模型损坏拒绝处理；真实推理后的 SQLite 写入故障回滚，旧原文及翻译保持一致');
    await clickText('//*','生成转写');await clickText('//*','开始本地转写');
    await until(async()=>{const root=join(dataDirectory,'podcast-local-work');for(const name of await readdir(root)){try{if((await stat(join(root,name,'progress.txt'))).size>0)return true;}catch{}}return false;},'real inference entered before forced exit');
    assert.deepEqual(snapshot(),original);
    await restartAfterCrash();await until(()=>enginePids().length===0,'forced-exit child terminated');
    assert.deepEqual(snapshot(),original);
    assert.equal((await readdir(join(dataDirectory,'podcast-local-work'))).length,0,'startup recovers exact temporary files');
    await openReader();await until(()=>script(()=>document.querySelector('.podcast-transcript-cues')?.textContent.includes('原有字幕-generated')),'old subtitles restored after forced exit');
    await record('真实推理时强退隔离应用，子进程终止；重启保留旧原文和翻译并回收临时音频');
    await clickText('//*','生成转写');await clickText('//*','开始本地转写');
    await until(()=>script(()=>!document.querySelector('[role="dialog"]')&&document.querySelector('.podcast-transcript-cues')?.textContent.includes('podcast')),'native local document committed and rendered',120000);
    assert.ok((await invoke('podcast_get_transcript',{episodeId:episode,variant:'generated'})).cues.some(c=>c.text.toLowerCase().includes('computer')));
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM podcast_episode_resources WHERE episode_id=? AND origin='translated'").get(episode).n,0);
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    await screenshot('local-generated-transcript');
    await writeFile(join(report,'local-whisper-result.json'),JSON.stringify({ok:true,modelSha256:createHash('sha256').update(await readFile(modelFile)).digest('hex'),settings,cancelledChildReaped:true,oldDataPreservedOnCancelAndFailure:true,oldDataPreservedOnForcedExit:true,temporaryAudioRecoveredAfterRestart:true,sqliteIntegrity:true,nativeViewports,responsiveEmulatedViewport:backendOnly?[920,620]:null,nativeSmallWindowVerified:!backendOnly,smallWindowBlocker:backendOnly?'On the separate desktop the native client resized correctly but WebView2 retained its old viewport; no input-desktop switch was made.':null,reducedMotion:true,sourceHash},null,2));
    await record('真实本地转写成功并显示共用时间轴，成功后清除旧翻译，SQLite 完整性检查通过');
    assert.equal(createHash('sha256').update(await readFile(audio)).digest('hex'),sourceHash);
  } finally { database.close(); }
}
