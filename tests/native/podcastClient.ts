import { invoke } from "@tauri-apps/api/core";
declare global {interface Window {__zoneClientAuditStarted?: boolean}}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(check:()=>boolean,name:string,timeout=20000)=>{const started=Date.now();while(!check()){if(Date.now()-started>timeout)throw Error(`${name}: timeout`);await delay(50);}};
const button=(text:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(el=>el.textContent?.trim()===text);
const click=async(text:string)=>{await until(()=>Boolean(button(text)),text);button(text)!.click();await delay(150);};
const assert=(condition:unknown,message:string)=>{if(!condition)throw Error(message);};
const capture=async(name:string)=>{await delay(700);await invoke("client_capture",{name});};
const inputValue=async(input:HTMLInputElement,value:string)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));await delay(100);};
const selectValue=async(select:HTMLSelectElement,value:string)=>{select.value=value;select.dispatchEvent(new Event("change",{bubbles:true}));await delay(100);};
async function run() {
  if(window.__zoneClientAuditStarted)return;window.__zoneClientAuditStarted=true;
  const checks:string[]=[];
  try {
    await invoke("client_record",{value:{kind:"started",url:location.href,readyState:document.readyState}});
    await until(()=>Boolean(button("播客")),"full App mount"); await click("播客"); await until(()=>Boolean(document.querySelector(".podcast-page")),"podcast page");
    assert(document.querySelectorAll("audio").length===1,"App must own exactly one audio element");
    await click("资料库"); await click("播客设置");await until(()=>Boolean(document.querySelector(".podcast-settings-fields select")),"global settings");
    const select=document.querySelector<HTMLSelectElement>(".podcast-settings-fields select")!;
    const checkbox=document.querySelector<HTMLInputElement>(".podcast-settings-fields input[type=checkbox]")!;
    assert(checkbox.getBoundingClientRect().width<=24&&checkbox.getBoundingClientRect().height<=24,"checkbox inherited oversized text field styling");
    const expected=select.value==="512"?1024:512;
    select.value=String(expected);select.dispatchEvent(new Event("change",{bubbles:true}));await delay(100);
    await invoke("client_window",{small:false});await capture("01-maintenance-1180");
    await invoke("client_window",{small:true});await capture("02-maintenance-920");
    const bounds=document.querySelector("[role=dialog]")!.getBoundingClientRect();
    assert(bounds.top>=0&&bounds.bottom<=innerHeight&&bounds.left>=0&&bounds.right<=innerWidth,"settings are cropped in the smallest window");
    assert(document.querySelector("[role=dialog]")?.contains(document.activeElement),"settings must trap focus");
    await click("保存");await until(()=>!document.querySelector("[role=dialog]"),"settings saved");
    const preferences=await invoke<{storageLimitMb:number}>("podcast_get_preferences",{});
    assert(preferences.storageLimitMb===expected,"global settings not persisted through native SQLite");
    checks.push("完整 App 中打开下载设置、保存原生 SQLite、1180×760 与 920×620、对话框焦点隔离");
    const open=document.querySelector<HTMLButtonElement>(".podcast-library-show-open");
    if(open){open.click();await click("节目设置");await until(()=>Boolean(document.querySelector(".podcast-settings-fields select")),"feed settings");await capture("03-feed-settings");
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));await until(()=>!document.querySelector("[role=dialog]"),"escape closes settings");checks.push("节目设置入口与 Escape 关闭且保留节目页");
      await until(()=>Boolean(document.querySelector(".podcast-search-page-status")),"native episode count");
      const search=document.querySelector<HTMLInputElement>(".podcast-episode-filters input[type=search]")!;
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!;
      setter.call(search,"不存在的单集 987");search.dispatchEvent(new Event("input",{bubbles:true}));await until(()=>Boolean(document.body.textContent?.includes("没有匹配的本地单集")),"empty local search");
      setter.call(search,"");search.dispatchEvent(new Event("input",{bubbles:true}));await until(()=>Boolean(document.querySelector(".podcast-search-page-status")),"reset local search");
      const order=document.querySelector<HTMLSelectElement>('select[aria-label="单集排序"]')!;order.value="oldest";order.dispatchEvent(new Event("change",{bubbles:true}));await delay(450);
      await capture("04-show-search-920");checks.push("原生资料库查询、节目内搜索空状态、清空查询与最早排序");
      await click("节目设置");await until(()=>Boolean(document.querySelector('select[aria-label="节目播放速度"]')),"playback preferences");
      const inherit=Array.from(document.querySelectorAll<HTMLInputElement>('.podcast-settings-fields input[type=checkbox]')).find(el=>el.parentElement?.textContent?.includes("使用默认播放设置"))!;
      if(inherit.checked)inherit.click();await delay(100);
      await selectValue(document.querySelector('select[aria-label="节目播放速度"]')!,"1.5");
      for(const [label,value] of [["跳过片头","10"],["跳过片尾","20"],["后退间隔","10"],["前进间隔","45"]])await inputValue(document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!,value);
      await capture("05-playback-settings-920");await click("保存");await until(()=>!document.querySelector("[role=dialog]"),"playback settings saved");
      const row=Array.from(document.querySelectorAll(".podcast-episode")).find(el=>el.textContent?.includes("离线单集"))!;
      row.scrollIntoView({block:"center"});(row.querySelector(".podcast-play-action") as HTMLButtonElement).click();
      const audio=document.querySelector("audio")!;
      await until(()=>!audio.paused&&audio.currentTime>=10,"actual offline playback and intro");
      assert(Math.abs(audio.duration-300)<1,"decoded fixture duration differs");assert(audio.playbackRate===1.5,"show playback rate not applied");
      const started=audio.currentTime;await delay(1200);assert(audio.currentTime>started+0.5,"media clock did not advance");
      const pause=document.querySelector<HTMLButtonElement>('.podcast-player button[title="暂停"]')!;pause.click();await until(()=>audio.paused,"native pause");const stopped=audio.currentTime;await delay(700);assert(Math.abs(audio.currentTime-stopped)<0.1,"paused clock moved");
      document.querySelector<HTMLButtonElement>('.podcast-player button[title="播放"]')!.click();await until(()=>!audio.paused,"native resume");
      const forward=document.querySelector<HTMLButtonElement>('.podcast-player button[title="前进 45 秒"]')!;assert(forward,"custom skip interval missing");const before=audio.currentTime;forward.click();await delay(250);assert(audio.currentTime>before+44,"custom forward seek not applied");
      await capture("06-offline-playing-920");audio.currentTime=285;await until(()=>audio.paused&&audio.currentTime>=299,"outro completion");
      checks.push("真实客户端解码离线 WAV、共用单一 audio、每节目 1.5 倍速、跳过片头、暂停续播、自定义前进与片尾完成");
    }
    await invoke("client_record",{value:{kind:"result",ok:true,checks}});
  } catch(error) {await invoke("client_record",{value:{kind:"result",ok:false,error:String(error),checks,body:document.body.textContent?.slice(-2000)}});}
}
void run();
