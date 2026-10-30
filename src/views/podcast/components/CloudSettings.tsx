import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { getCloudSettings, saveCloudSettings, type CloudSettings as Settings } from "../api";
import { LocalTranscriptionSettings } from "./LocalTranscriptionSettings";
export function CloudSettings() {
  const [value,setValue]=useState<Settings|null>(null),[key,setKey]=useState("");
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[saved,setSaved]=useState(false),[revision,setRevision]=useState(0);
  useEffect(()=>{let disposed=false;setError(null);void getCloudSettings().then(value=>{if(!disposed)setValue(value);}).catch(reason=>{if(!disposed)setError(String(reason));});return()=>{disposed=true;};},[revision]);
  function update(next:Settings){setValue(next);setSaved(false);}
  async function save(clearKey=false){if(!value||busy)return;setBusy(true);setError(null);try{setValue(await saveCloudSettings(value,key||undefined,clearKey));setKey("");setSaved(true);}catch(reason){setError(String(reason));}finally{setBusy(false);}}
  return <div className="podcast-cloud-settings"><LocalTranscriptionSettings/><h3>云端转写与中文翻译</h3>
    {value && <><div className="podcast-playback-setting-grid">
      <label className="podcast-cloud-address">服务地址<input type="url" aria-label="转写服务地址" value={value.baseUrl} disabled={busy} onChange={event=>update({...value,baseUrl:event.target.value})}/></label>
      <label>转写模型<input aria-label="转写模型" value={value.transcriptionModel} disabled={busy} onChange={event=>update({...value,transcriptionModel:event.target.value})}/></label>
      <label>翻译模型<input aria-label="翻译模型" value={value.translationModel} placeholder="填写服务支持的模型" disabled={busy} onChange={event=>update({...value,translationModel:event.target.value})}/></label>
      <label className="podcast-cloud-address">服务密钥<input type="password" autoComplete="new-password" aria-label="转写服务密钥" value={key} placeholder={value.hasKey?"已保存 · 留空保留":"未配置"} disabled={busy} onChange={event=>{setKey(event.target.value);setSaved(false);}}/></label>
    </div><details className="podcast-preference-advanced"><summary>服务要求与隐私</summary><small>支持 OpenAI 兼容接口。转写模型须返回 verbose_json 时间段；翻译模型须支持 JSON 输出。</small><small>密钥由 Windows 保护，不进入备份或同步。每次处理前确认上传范围，服务可能收费。</small></details>
    <div className="podcast-cloud-actions podcast-preference-save"><Button variant="primary" busy={busy} onClick={()=>void save()}>保存服务设置</Button>{value.hasKey&&<Button disabled={busy} onClick={()=>void save(true)}>清除密钥</Button>}<span role="status">{saved?"服务设置已保存":""}</span></div></>}
    {error&&<p role="alert">{error}{!value&&<Button onClick={()=>setRevision(value=>value+1)}>重试读取</Button>}</p>}
  </div>;
}
