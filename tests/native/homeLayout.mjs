import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {hash} from './artifactSupport.mjs';

// Only the validated CI identity and generated audio may enter this destructive fixture flow.
export async function testHomeLayout({root, report, dataDirectory, manifest, executable, media, paths,
  invoke, script, command, click, clickText, until, screenshot, ownedProcesses, record}) {
  assert.match(manifest.identifier,/^com\.zone\.player\.ci\.run-/);
  assert.equal(resolve(dataDirectory),resolve(process.env.APPDATA,manifest.identifier));
  const before=await invoke('music_get_library_snapshot');
  assert.ok(before.tracks.every(track=>resolve(track.path).startsWith(resolve(root,'.tmp')+'\\')),'Refuse any non-fixture media');
  const cases=[], issues=[];
  const persist=()=>writeFile(join(report,'home-layout-result.json'),JSON.stringify({ok:false,identifier:manifest.identifier,
    executableSha256:manifest.executableSha256,userAudio:false,cases,issues},null,2));
  const keys=async(key)=>command('POST','/actions',{actions:[{type:'key',id:'home-keyboard',actions:[{type:'keyDown',value:key},{type:'keyUp',value:key}]}]});
  const resize=async(width,height)=>{
    const pids=ownedProcesses();assert.equal(pids.length,1);
    const result=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'tests/native/setBaselineWindow.ps1'),
      '-RootPid',String(pids[0]),'-ExpectedExecutable',executable,'-Identifier',manifest.identifier,'-Width',String(width),'-Height',String(height)],{windowsHide:true,timeout:30000});
    await until(()=>script((w,h)=>innerWidth===w&&innerHeight===h,width,height),'actual home native viewport');
    return JSON.parse(result.stdout);
  };
  const inspect=async(label,sizing)=>{
    const native=await invoke('plugin:window|inner_size',{label:'main'});
    const geometry=await script(()=>{
      const rect=e=>e?.getBoundingClientRect().toJSON();
      const metrics=e=>({rect:rect(e),clientWidth:e.clientWidth,clientHeight:e.clientHeight,scrollWidth:e.scrollWidth,scrollHeight:e.scrollHeight,
        scrollLeft:e.scrollLeft,scrollTop:e.scrollTop,overflowX:getComputedStyle(e).overflowX,overflowY:getComputedStyle(e).overflowY});
      return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,shell:rect(document.querySelector('.shell')),home:metrics(document.querySelector('.quickplay')),
        viewport:document.querySelector('.quickplay-viewport')?metrics(document.querySelector('.quickplay-viewport')):null,
        groups:[...document.querySelectorAll('[data-panorama-section]')].map(e=>({id:e.dataset.panoramaSection,...metrics(e),
          scroll:e.querySelector('.quick-section-scroll')?metrics(e.querySelector('.quick-section-scroll')):null})),
        controls:[...document.querySelectorAll('.window-controls button,.player button,.quickplay-empty-content button,.quick-panorama-scrollbar,.quick-panorama-edges button')]
          .filter(e=>e.getClientRects().length).map(e=>({label:e.title||e.getAttribute('aria-label')||e.textContent,rect:rect(e)}))};
    });
    const found=[];
    if(native.width!==geometry.width*geometry.dpr||native.height!==geometry.height*geometry.dpr)found.push('Native client / WebView mismatch');
    if(geometry.shell.width!==geometry.width||geometry.shell.height!==geometry.height)found.push('Shell exceeds viewport');
    for(const control of geometry.controls){const r=control.rect;if(r.left<0||r.top<0||r.right>geometry.width||r.bottom>geometry.height)found.push(`Control outside window: ${control.label}`);}
    for(const group of geometry.groups){
      if(group.scroll&&group.scroll.scrollWidth>group.scroll.clientWidth+1)found.push(`Section clips horizontal content: ${group.id}`);
      if(group.rect.top<geometry.home.rect.top||group.rect.bottom>geometry.home.rect.bottom)found.push(`Group exceeds home height: ${group.id}`);
    }
    cases.push({label,sizing,native,geometry,issues:found});issues.push(...found.map(issue=>({label,issue})));
    await screenshot(`home-${label}`);await persist();
  };
  const refresh=async()=>{await command('POST','/refresh',{});await until(()=>script(()=>Boolean(document.querySelector('.quickplay'))&&!document.querySelector('.startup-loading')),'home ready');};
  const checkSizes=async(state)=>{
    for(const [width,height] of [[1180,760],[920,620],[1180,620],[920,760],[1180,760]])await inspect(`${state}-${width}x${height}`,await resize(width,height));
    await click('css selector','.window-controls button[title="最大化"]');
    await until(()=>invoke('plugin:window|is_maximized',{label:'main'}),'home maximized');
    await until(async()=>{const n=await invoke('plugin:window|inner_size',{label:'main'});return script((w,h)=>innerWidth*devicePixelRatio===w&&innerHeight*devicePixelRatio===h,n.width,n.height);},'home maximized viewport');
    await inspect(`${state}-maximized`);
    await click('css selector','.window-controls button[title="最大化"]');
    await until(()=>script(()=>innerWidth===1180&&innerHeight===760),'home restored');await inspect(`${state}-restored`);
  };
  await invoke('music_clear_library');await refresh();
  assert.equal((await invoke('music_get_library_snapshot')).tracks.length,0);
  await until(()=>script(()=>Boolean(document.querySelector('.quickplay-empty-content button'))),'empty home action');
  await checkSizes('empty');
  // Existing generated WAVs provide the sparse library; no playback is started.
  const scan=async(folder)=>asynchronousScan(folder);
  const asynchronousScan=async(folder)=>{
    const value=await command('POST','/execute/async',{script:`const done=arguments[arguments.length-1];const api=window.__TAURI_INTERNALS__;const cb=api.transformCallback(()=>{});api.invoke('music_scan_library',{folders:[{path:arguments[0],name:'Home synthetic fixture'}],progress:'__CHANNEL__:'+cb}).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)})).finally(()=>api.unregisterCallback(cb));`,args:[folder]});
    if(!value.ok)throw Error(value.error);return value.value;
  };
  assert.equal((await scan(media)).tracks.length,2);await refresh();await checkSizes('sparse');
  const dense=join(report,'home-media');await mkdir(dense);
  const files=[];for(let i=0;i<32;i++){const path=join(dense,`Home Synthetic ${String(i).padStart(2,'0')}.wav`);await copyFile(paths[0],path);files.push(path);}
  await invoke('music_clear_library');
  const result=await scan(dense);assert.equal(result.tracks.length,32);
  const database=new DatabaseSync(join(dataDirectory,'zone.sqlite'));
  const tracks=result.tracks.toSorted((a,b)=>a.path.localeCompare(b.path)),now=Date.now(),day=86400000;
  try{
    database.exec('PRAGMA busy_timeout=3000');
    const update=database.prepare('UPDATE music_tracks SET title=?,artist=?,album=?,album_artist=?,added_at=? WHERE id=?');
    tracks.forEach((t,i)=>update.run(`主页合成歌曲 ${i} · 长标题用于核对裁剪和省略显示`,`合成艺术家 ${i}`,`主页合成专辑 ${i}` ,`合成艺术家 ${i}`,now-i*day,t.id));
  }finally{database.close();}
  await invoke('music_save_track_activity',{activity:Object.fromEntries(tracks.map((t,i)=>[t.id,{addedAt:now-i*day,playCount:i>=12&&i<20?30-i:1,completedCount:0,skipCount:0,lastPlayedAt:now-(i+1)*day,lastSkippedAt:null}]))});
  const playlists=(await invoke('music_get_library_snapshot')).playlists;
  await invoke('music_save_playlists',{playlists:playlists.map(p=>p.id==='favorites'?{...p,trackIds:tracks.slice(24).map(t=>t.id)}:p)});
  await invoke('music_save_playback_state',{playback:{activeTrackId:tracks[0].id,positionSeconds:0,queue:tracks.map(t=>t.id),playHistory:tracks.slice(0,12).map(t=>t.id),volume:0,shuffle:false,repeat:'off'}});
  await invoke('music_save_home_pins',{pins:tracks.slice(0,12).map((t,i)=>({id:`track:${t.id}`,kind:'track',targetId:t.id,createdAt:now-i,size:['large','wide','medium','small'][i%4],live:false,tone:['pink','teal','blue','orange'][i%4]}))});
  await refresh();await until(()=>script(()=>document.querySelectorAll('.quick-pin').length===12),'mixed-size pin fixture');
  assert.deepEqual(await script(()=>[...document.querySelectorAll('[data-panorama-section]')].map(e=>e.dataset.panoramaSection)),['pins','continue','recent','history','most','forgotten']);
  await checkSizes('dense');
  await resize(920,620);
  // Reach the panorama ends with real keyboard input, then each section with the visible controls.
  await script(()=>document.querySelector('.quickplay-viewport').focus());await keys('\uE010');
  await until(()=>script(()=>{const e=document.querySelector('.quickplay-viewport');return e.scrollLeft>=e.scrollWidth-e.clientWidth-1;}),'home End reaches last group');
  await inspect('dense-end-920x620');
  await keys('\uE011');await until(()=>script(()=>document.querySelector('.quickplay-viewport').scrollLeft===0),'home Home reaches first group');
  const reachable=[];
  for(let index=0;index<6;index++){
    const items=await script(()=>{
      const v=document.querySelector('.quickplay-viewport'),vr=v.getBoundingClientRect();
      return [...document.querySelectorAll('[data-panorama-section]')].filter(e=>{const r=e.getBoundingClientRect();return r.left>=vr.left-1&&r.left<vr.right&&r.right<=vr.right+1;}).map(e=>({id:e.dataset.panoramaSection,scroll:e.querySelector('.quick-section-scroll')?{client:e.querySelector('.quick-section-scroll').clientHeight,total:e.querySelector('.quick-section-scroll').scrollHeight}:null}));
    });
    for(const item of items){
      if(!reachable.includes(item.id))reachable.push(item.id);
      if(item.scroll?.total>item.scroll.client+1){
        const position=await script(id=>{const e=document.querySelector(`[data-panorama-section="${id}"] .quick-section-scroll`),r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};},item.id);
        await command('POST','/actions',{actions:[{type:'wheel',id:'home-wheel',actions:[{type:'scroll',x:position.x,y:position.y,deltaX:0,deltaY:2000,duration:100,origin:'viewport'}]}]});
        await until(()=>script(id=>{const e=document.querySelector(`[data-panorama-section="${id}"] .quick-section-scroll`);return e.scrollTop>=e.scrollHeight-e.clientHeight-1;},item.id),'section bottom reached by wheel');
      }
    }
    await inspect(`dense-step-${index}-920x620`);
    if(await script(()=>document.querySelector('[data-panorama-step="1"]').disabled))break;
    await click('css selector','[data-panorama-step="1"]');
    await new Promise(done=>setTimeout(done,650));
  }
  for(const id of ['continue','recent','history','most','forgotten'])if(!reachable.includes(id))issues.push({label:'dense-navigation',issue:`Section never fully reachable: ${id}`});
  await script(()=>document.querySelector('.quickplay-viewport').focus());await keys('\uE011');
  await click('css selector','.quick-pins-edit');await inspect('dense-pin-edit-920x620');
  await click('css selector','.quick-pins-edit');
  await command('POST','/ms/cdp/execute',{cmd:'Emulation.setEmulatedMedia',params:{features:[{name:'prefers-reduced-motion',value:'reduce'}]}});
  await checkSizes('dense-reduced');
  for(const path of files)assert.equal(hash(await readFile(path)),hash(await readFile(paths[0])),'Generated media must remain unchanged');
  await persist();assert.equal(issues.length,0,JSON.stringify(issues));
  const remaining=await testHomeRemaining({root,report,dataDirectory,manifest,executable,invoke,script,command,click,clickText,until,screenshot,ownedProcesses,record});
  await writeFile(join(report,'home-layout-result.json'),JSON.stringify({ok:true,identifier:manifest.identifier,executableSha256:manifest.executableSha256,userAudio:false,cases,issues,reachable,
    nativeResize:true,keyboardEnds:true,verticalWheel:true,reducedMotion:true,remaining,mediaHashes:await Promise.all(files.map(async path=>({path,sha256:hash(await readFile(path))})))},null,2));
  await record('Real home empty/sparse/dense layouts, mixed pins, recommendation reachability, native resize and reduced motion passed');
}


export async function testHomeRemaining({root,report,dataDirectory,manifest,executable,invoke,script,command,click,clickText,until,screenshot,ownedProcesses,record,expectedTrackCount=32}) {
  assert.match(manifest.identifier,/^com\.zone\.player\.ci\.run-/);
  assert.equal(resolve(dataDirectory),resolve(process.env.APPDATA,manifest.identifier));
  const snapshot=await invoke('music_get_library_snapshot');
  assert.equal(snapshot.tracks.length,expectedTrackCount);
  assert.ok(snapshot.tracks.every(track=>resolve(track.path).startsWith(resolve(root,'.tmp')+'\\')),'Only generated CI media is permitted');
  const tracks=snapshot.tracks.filter(track=>dirname(track.path).endsWith('home-media')).toSorted((a,b)=>a.path.localeCompare(b.path)),cases=[],pinFocus=[],navigation=[];
  assert.equal(tracks.length,32,'Require all 32 generated home fixtures');
  const result={ok:false,snapshotTrackCount:snapshot.tracks.length,fixtureTrackCount:tracks.length,identifier:manifest.identifier,executableSha256:manifest.executableSha256,userAudio:false,cases,pinFocus,navigation};
  const save=()=>writeFile(join(report,'home-remaining-result.json'),JSON.stringify(result,null,2));
  const keys=async key=>command('POST','/actions',{actions:[{type:'key',id:'home-remaining-keyboard',actions:[{type:'keyDown',value:key},{type:'keyUp',value:key}]}]});
  const observe=async label=>{
    const native=await invoke('plugin:window|inner_size',{label:'main'});
    const value=await script(()=>{const r=e=>e.getBoundingClientRect().toJSON();return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,shell:r(document.querySelector('.shell')),home:r(document.querySelector('.quickplay')),left:document.querySelector('.quickplay-viewport').scrollLeft,audioPaused:[...document.querySelectorAll('audio')].every(e=>e.paused),controls:[...document.querySelectorAll('.window-controls button,.player button')].filter(e=>e.getClientRects().length).map(r)};});
    cases.push({label,native,value});await save();
    assert.equal(value.width*value.dpr,native.width);assert.equal(value.height*value.dpr,native.height);
    assert.equal(value.shell.width,value.width);assert.equal(value.shell.height,value.height);assert.equal(value.audioPaused,true);
    for(const r of value.controls)assert.ok(r.left>=0&&r.top>=0&&r.right<=value.width&&r.bottom<=value.height,'Window or playback control clipped');
    await screenshot('home-'+label);
  };
  const resize=async(w,h,label)=>{
    const pids=ownedProcesses();assert.equal(pids.length,1);
    const resized=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'tests/native/setBaselineWindow.ps1'),'-RootPid',String(pids[0]),'-ExpectedExecutable',executable,'-Identifier',manifest.identifier,'-Width',String(w),'-Height',String(h)],{windowsHide:true,timeout:30000});
    assert.equal(JSON.parse(resized.stdout).windowClass,'Tauri Window');
    await until(()=>script((w,h)=>innerWidth===w&&innerHeight===h,w,h),'remaining native viewport');await observe(label);
  };
  try {
    const pins=tracks.slice(0,12).map((t,i)=>({id:'track:'+t.id,kind:'track',targetId:t.id,createdAt:Date.now()-i,size:'large',live:false,tone:'pink'}));
    await invoke('music_save_home_pins',{pins});await command('POST','/refresh',{});
    await until(()=>script(()=>document.querySelectorAll('.quick-pin.large').length===12),'all large pin fixture');
    for(const reduced of [false,true]) {
      await command('POST','/ms/cdp/execute',{cmd:'Emulation.setEmulatedMedia',params:{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]}});
      const mode=reduced?'reduced':'normal';
      for(const [w,h] of [[1180,760],[920,620]])await resize(w,h,'large-'+mode+'-'+w+'x'+h);
      await new Promise(done=>setTimeout(done,1000));
      await script(()=>document.querySelector('.quick-pin-tile').focus());
      for(let i=0;i<12;i++) {
        const focus=await script(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),v=document.querySelector('.quickplay-viewport').getBoundingClientRect();return {id:e.closest('[data-pin-id]')?.dataset.pinId,rect:r.toJSON(),clip:v.toJSON(),hit:e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};});
        pinFocus.push({mode,index:i,...focus});await save();
        assert.equal(focus.id,pins[i].id,'Tab must visit every large pin in order');
        assert.ok(focus.rect.left>=focus.clip.left&&focus.rect.right<=focus.clip.right&&focus.rect.top>=focus.clip.top&&focus.rect.bottom<=focus.clip.bottom&&focus.hit,'Focused large pin is clipped or covered');
        if(i<11)await keys('\uE004');
      }
      await observe('large-'+mode+'-last-pin-focused');
      await click('css selector','.window-controls button[title="最大化"]');
      await until(()=>invoke('plugin:window|is_maximized',{label:'main'}),'remaining maximize');
      await until(async()=>{const n=await invoke('plugin:window|inner_size',{label:'main'});return script((w,h)=>innerWidth*devicePixelRatio===w&&innerHeight*devicePixelRatio===h,n.width,n.height);},'remaining maximized viewport');
      await observe('large-'+mode+'-maximized');
      await click('css selector','.window-controls button[title="最大化"]');
      await until(()=>script(()=>innerWidth===920&&innerHeight===620),'remaining restored viewport');await observe('large-'+mode+'-restored');
      await script(()=>document.querySelector('.quickplay-viewport').focus());await keys('\uE010');
      const left=await script(()=>document.querySelector('.quickplay-viewport').scrollLeft);
      await clickText('//nav[@aria-label="主要导航"]','收藏');
      await until(()=>script(()=>!document.querySelector('.quickplay')),'leave home for collection');
      await clickText('//nav[@aria-label="主要导航"]','quickplay');
      await until(()=>script(()=>Boolean(document.querySelector('.quickplay-viewport'))),'return home');
      await until(()=>script(expected=>Math.abs(document.querySelector('.quickplay-viewport').scrollLeft-expected)<=1,left),'restore home panorama offset');
      navigation.push({mode,from:'collection',restoredLeft:left});await observe('large-'+mode+'-returned');
    }
    result.ok=true;await save();await record('All 12 large pins reached by native Tab; return-home scroll position, resize and maximize/restore passed in both motion modes');return result;
  } catch(error){result.error=error.stack??String(error);await save();throw error;}
}
