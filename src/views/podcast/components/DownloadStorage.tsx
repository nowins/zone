import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { getDownloadStorage, type PodcastDownloadStorage } from "../api";
import { formatFileSize } from "../format";
import { PodcastLoading } from "./primitives";

export function DownloadStorage({ revision }: { revision: number }) {
  const [storage, setStorage] = useState<PodcastDownloadStorage | null>(null);
  const [error, setError] = useState(""); const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false, busy = false;
    const load = async () => { if (busy) return; busy = true; try { const value = await getDownloadStorage(); if (!disposed) { setStorage(value); setError(""); } } catch (reason) { if (!disposed) setError(String(reason)); } finally { busy = false; } };
    void load(); const timer = window.setInterval(() => void load(), 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [revision, retry]);
  return <section className="podcast-storage-summary" aria-label="下载空间">
    <h2>下载空间</h2>
    {!storage && !error && <PodcastLoading label="正在统计下载空间" />}
    {storage && <><p>已占用 {formatFileSize(storage.completedBytes + storage.partialBytes)} · 上限 {storage.limitBytes ? formatFileSize(storage.limitBytes) : "不限"}</p>
      <p>完整音频 {formatFileSize(storage.completedBytes)} · 未完成文件 {formatFileSize(storage.partialBytes)}</p>
      <p>清理已听完可释放约 {formatFileSize(storage.reclaimableBytes)} · {storage.reclaimableCount} 集</p>
      {storage.limitBytes > 0 && storage.completedBytes + storage.partialBytes >= storage.limitBytes && <p role="status">空间已达上限，可清理下载或在播客设置中调整上限</p>}</>}
    {error && <p role="alert">空间统计暂不可用<Button variant="ghost" onClick={() => setRetry(value => value + 1)}>重试</Button></p>}
  </section>;
}
