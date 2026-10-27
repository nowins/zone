import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { Select } from "../../../components/Select";
import { getLocalTranscriptionStatus, importLocalModel, openPodcastLink, saveTranscriptionSettings, type LocalTranscriptionStatus, type TranscriptionSettings } from "../api";

export function LocalTranscriptionSettings() {
  const [status, setStatus] = useState<LocalTranscriptionStatus | null>(null);
  const [value, setValue] = useState<TranscriptionSettings | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [saved, setSaved] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    void getLocalTranscriptionStatus().then(result => { if (!disposed) { setStatus(result); setValue(result.settings); setError(null); } }).catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [revision]);
  function update(next: TranscriptionSettings) { setValue(next); setSaved(false); }
  async function save() {
    if (!value || busy) return;
    setBusy(true); setError(null);
    try { await saveTranscriptionSettings(value); setSaved(true); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  }
  async function importModel() {
    if (!value || busy) return;
    setBusy(true); setError(null);
    try { setStatus(await importLocalModel(value.modelId)); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  }
  const model = status?.models.find(model => model.id === value?.modelId);
  return <section className="podcast-local-settings" aria-label="转写方式与本地模型">
    {value && <>
      <div className="podcast-playback-setting-grid">
        <label>转写方式<Select aria-label="转写方式" value={value.backend} disabled={busy} onValueChange={backend => update({...value, backend: backend as TranscriptionSettings["backend"]})}><option value="cloud">云端转写 · 上传音频</option><option value="local">本地转写 · CPU · 不上传音频</option></Select></label>
      </div>
      {value.backend === "local" && <>
        <p>本地识别原文，不上传音频，也不会自动切换云端。中文翻译仍需单独确认云端处理。</p>
        <div className="podcast-playback-setting-grid">
          <label>多语言模型<Select aria-label="本地多语言模型" value={value.modelId} disabled={busy} onValueChange={modelId => update({...value, modelId})}>{status?.models.map(model => <option key={model.id} value={model.id}>{model.id === "base-q5_1" ? "基础模型 · 57 MiB · 推荐" : "轻量模型 · 31 MiB · 较快"}{model.installed ? " · 已导入" : " · 未导入"}</option>)}</Select></label>
          <label>音频语言<Select aria-label="本地音频语言" value={value.language} disabled={busy} onValueChange={language => update({...value, language: language as TranscriptionSettings["language"]})}><option value="auto">自动识别</option><option value="zh">中文</option><option value="en">英语</option></Select></label>
          <label>CPU 线程<Select aria-label="本地转写线程数" value={value.threads} disabled={busy} onValueChange={threads => update({...value, threads: Number(threads)})}>{[1,2,4,8].map(n => <option key={n} value={n}>{n} 线程</option>)}</Select></label>
        </div>
        {model && <div className="podcast-local-model-info">
          <p>{model.filename} · {model.installed ? "已导入，处理前再次校验" : "尚未导入"} · MIT 许可</p>
          <div className="podcast-cloud-actions"><Button disabled={busy} onClick={() => void openPodcastLink(model.sourceUrl).catch(reason => setError(String(reason)))}>打开官方模型下载</Button><Button busy={busy} onClick={() => void importModel()}>选择文件并校验导入</Button></div>
          <small>下载来源：Hugging Face / ggerganov/whisper.cpp。仅在打开链接后自行下载，应用不自动下载模型。</small>
          <details className="podcast-preference-advanced"><summary>校验、磁盘与运行限制</summary>
            <small>SHA-256：{model.sha256}</small><small className="podcast-local-path">模型目录：{status?.modelDirectory}</small>
            <small>可用空间：{status?.availableBytes == null ? "暂不可读" : `${(status.availableBytes / 1024 ** 3).toFixed(1)} GiB`}。导入需模型大小及额外 32 MiB；每次转写需 32 MiB 临时空间。</small>
            <small>CPU 引擎 whisper.cpp 1.8.2；单任务，最多 8 线程，进程内存上限 1.5 GiB，音频上限 8 小时。长音频可能耗时较久。</small>
          </details>
        </div>}
        {!status?.engineReady && <p role="status">{status?.engineError ?? "本地引擎尚不可用"}</p>}
      </>}
      <div className="podcast-cloud-actions podcast-preference-save"><Button variant="primary" busy={busy} onClick={() => void save()}>保存转写方式</Button><span role="status">{saved ? "转写方式已保存" : ""}</span></div>
    </>}
    {error && <p role="alert">{error}{!value && <Button onClick={() => setRevision(n => n + 1)}>重试读取</Button>}</p>}
  </section>;
}
