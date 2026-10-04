import {build} from 'esbuild';
import {promises as fs,createWriteStream} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const mode=process.env.ZONE_PODCAST_CLIENT_MODE??'core';
if(!['core','network','restart','manual'].includes(mode))throw Error('Unknown client audit mode');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const report=path.join(root,'.tmp','podcast-client',new Date().toISOString().replaceAll(':','-')+'-'+process.pid);
const workspace=path.join(report,'workspace');
const target=path.join(root,'.tmp','podcast-review-rust-target');
function replaceOnce(source,anchor,replacement) {
  if(source.split(anchor).length!==2)throw Error(`Client source anchor changed: ${anchor}`);
  return source.replace(anchor,replacement);
}
await fs.mkdir(workspace,{recursive:true});
await fs.cp(path.join(root,'src-tauri'),workspace,{recursive:true,filter:p=>!['target','gen','.cargo','.tauri'].includes(path.basename(p))});
const config=JSON.parse(await fs.readFile(path.join(workspace,'tauri.conf.json'),'utf8'));
config.identifier=process.env.ZONE_PODCAST_CLIENT_IDENTIFIER??(mode==='network'?`com.zone.player.podcast.clientnetwork${process.pid}`:'com.zone.player.podcast.clientreview');
if(!/^com\.zone\.player\.podcast\.client(?:network\d+|review)$/.test(config.identifier))throw Error('Invalid isolated client identity');
config.app.windows[0].title='Zone 播客完整客户端验收';
config.app.windows[0].visible=true;
config.build.frontendDist=path.relative(workspace,path.join(root,'dist')).replaceAll('\\','/');
delete config.build.devUrl;
config.bundle.resources={[path.join(root,'packaging','THIRD_PARTY_NOTICES.txt')]:'THIRD_PARTY_NOTICES.txt'};
await fs.writeFile(path.join(workspace,'tauri.conf.json'),JSON.stringify(config,null,2));
// Native shell integration must not replace the user's installed Zone shortcut.
const mediaModule=path.join(workspace,'src','system_media','windows_impl','mod.rs');
await fs.writeFile(mediaModule,replaceOnce(await fs.readFile(mediaModule,'utf8'),'const APP_USER_MODEL_ID: &str = "com.zone.player";',`const APP_USER_MODEL_ID: &str = "${config.identifier}";`));
const identityModule=path.join(workspace,'src','system_media','windows_impl','identity.rs');
await fs.writeFile(identityModule,replaceOnce(await fs.readFile(identityModule,'utf8'),'shortcut_directory.join("Zone.lnk")','shortcut_directory.join("Zone Podcast Client Review.lnk")'));
await fs.copyFile(path.join(root,'tests','native','podcastClient.rs'),path.join(workspace,'src','podcastClient.rs'));
const manifest=path.join(workspace,'Cargo.toml');await fs.writeFile(manifest,(await fs.readFile(manifest,'utf8')).replace('[dependencies]','[dependencies]\nwebview2-com = "0.38.2"'));
const lib=path.join(workspace,'src','lib.rs');let source=await fs.readFile(lib,'utf8');
source='#[path = "podcastClient.rs"] mod podcast_client;\n'+source;
source=replaceOnce(source,'.invoke_handler(tauri::generate_handler![','.invoke_handler(tauri::generate_handler![podcast_client::client_record,podcast_client::client_capture,podcast_client::client_window,podcast_client::client_media,podcast_client::client_motion,podcast_client::client_context,podcast_client::client_add_update,podcast_client::client_backup_tick,');
source=replaceOnce(source,'app.manage(music_state);','app.manage(music_state);\n      podcast_client::initialize(app.handle()).map_err(std::io::Error::other)?;');
source=replaceOnce(source,'.on_page_load(move |webview, payload| {','.on_page_load(move |webview, payload| { if payload.event()==tauri::webview::PageLoadEvent::Finished && payload.url().scheme()!="about" { let _=webview.eval(include_str!("podcastClient.js")); }');
await fs.writeFile(lib,source);
await build({entryPoints:[path.join(root,'tests','native','podcastClient.ts')],outfile:path.join(workspace,'src','podcastClient.js'),bundle:true,format:'iife',platform:'browser'});
console.log('完整客户端报告：'+report);
async function command(exe,args,log,env=process.env,timeout=180000) {
  const stream=createWriteStream(path.join(report,log));const child=spawn(exe,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env});
  child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});
  const timer=setTimeout(()=>child.kill(),timeout);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});clearTimeout(timer);stream.end();
  if(code!==0)throw Error(`${exe} exited ${code}; ${report}/${log}`);
}
await command(process.execPath,[path.join(root,'node_modules','typescript','bin','tsc'),'--noEmit','--target','ES2022','--module','ESNext','--moduleResolution','Bundler','--strict','--skipLibCheck','--lib','DOM,DOM.Iterable,ES2022',path.join(root,'tests','native','podcastClient.ts')],'typecheck.log');
await command('cargo',['build','--offline','--features','tauri/custom-protocol','--manifest-path',path.join(workspace,'Cargo.toml'),'--target-dir',target],'build.log');
const bin=path.join(report,'bin');await fs.mkdir(bin);const exe=path.join(bin,'zone-player.exe');await fs.copyFile(path.join(target,'debug','zone-player.exe'),exe);
for(const dll of ['vcruntime140.dll','vcruntime140_1.dll'])await fs.copyFile(path.join(process.env.WINDIR??'C:/Windows','System32',dll),path.join(bin,dll));
await command(exe,[],'client.log',{...process.env,ZONE_PODCAST_CLIENT_REPORT:report},mode==='manual'?900000:mode==='network'?240000:120000);
const result=JSON.parse(await fs.readFile(path.join(report,'result.json'),'utf8'));if(!result.ok)throw Error(JSON.stringify(result));
console.log(mode==='manual'?'原生窗口人工流程结束：'+report:JSON.stringify(result));
