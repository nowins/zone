import { invoke } from "@tauri-apps/api/core";
declare global {interface Window {__zoneClientAuditStarted?: boolean}}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(check:()=>boolean,name:string,timeout=20000)=>{const started=Date.now();while(!check()){if(Date.now()-started>timeout)throw Error(`${name}: timeout`);await delay(50);}};
const button=(text:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(el=>el.textContent?.trim()===text);
const click=async(text:string)=>{await until(()=>Boolean(button(text)),text);button(text)!.click();await delay(150);};
const assert=(condition:unknown,message:string)=>{if(!condition)throw Error(message);};
const capture=async(name:string)=>{await delay(700);await invoke("client_capture",{name});};
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
      window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));await until(()=>!document.querySelector("[role=dialog]"),"escape closes settings");checks.push("节目设置入口与 Escape 关闭");}
    await invoke("client_record",{value:{kind:"result",ok:true,checks}});
  } catch(error) {await invoke("client_record",{value:{kind:"result",ok:false,error:String(error),checks,body:document.body.textContent?.slice(-2000)}});}
}
void run();
