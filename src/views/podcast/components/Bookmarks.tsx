import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { formatTime } from "../../../utils/music";
import { addEpisodeBookmark, listEpisodeBookmarks, removeEpisodeBookmark, restoreEpisodeBookmark, updateEpisodeBookmark, type PodcastBookmark } from "../api";
import { copyPodcastShareUrl, shareablePodcastEpisodeUrl } from "../format";
import { PodcastLoading } from "./primitives";
import type { PodcastEpisode } from "../../../types";

export function EpisodeBookmarks({ episode, position, onPlayAt }: { episode: PodcastEpisode; position: number; onPlayAt: (position: number) => void }) {
  const [items, setItems] = useState<PodcastBookmark[]>([]), [label, setLabel] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<PodcastBookmark | null>(null), [undo, setUndo] = useState<PodcastBookmark | null>(null);
  const [revision, setRevision] = useState(0), [loading, setLoading] = useState(true);
  const owner = useRef(0);
  useEffect(() => { owner.current++; return () => { owner.current++; }; }, [episode.id]);
  useEffect(() => {
    let disposed = false; setLoading(true);
    void listEpisodeBookmarks(episode.id).then(value => { if (!disposed) setItems(value); }).catch(() => { if (!disposed) setNotice("书签读取失败"); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [episode.id, revision]);
  useEffect(() => {
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === episode.id) setRevision(value => value + 1); };
    window.addEventListener("zone-podcast-bookmarks-changed", changed);
    return () => window.removeEventListener("zone-podcast-bookmarks-changed", changed);
  }, [episode.id]);
  useEffect(() => { if (!undo) return; const timer = window.setTimeout(() => setUndo(null), 30000); return () => window.clearTimeout(timer); }, [undo]);
  async function mutate(kind: "save" | "delete" | "undo", item?: PodcastBookmark) {
    if (busy) return; const epoch = owner.current; setBusy(true); setNotice("");
    try {
      const value = kind === "delete" && item ? await removeEpisodeBookmark(episode.id, item.id)
        : kind === "undo" && undo ? await restoreEpisodeBookmark(episode.id, undo)
        : editing ? await updateEpisodeBookmark(episode.id, editing, label) : await addEpisodeBookmark(episode.id, Math.max(0, position), label);
      if (epoch !== owner.current) return;
      setItems(value);
      if (kind === "delete" && item) { setUndo(item); setNotice("已删除书签"); if (editing?.id === item.id) { setEditing(null); setLabel(""); } }
      else { setLabel(""); setEditing(null); if (kind === "undo") setUndo(null); setNotice(kind === "undo" ? "已恢复书签" : "书签已保存"); }
    } catch (reason) { if (epoch === owner.current) setNotice(String(reason)); }
    finally { if (epoch === owner.current) setBusy(false); }
  }
  async function share(seconds: number) {
    const url = shareablePodcastEpisodeUrl(episode); if (!url) { setNotice("这集没有可分享的链接"); return; }
    const link = new URL(url); link.hash = "t=" + Math.floor(Math.max(0, seconds));
    try { await copyPodcastShareUrl(episode.title+"\n"+formatTime(seconds)+"\n"+link.href); setNotice("已复制单集链接和时间；接收软件可能需要手动定位"); }
    catch { setNotice("复制失败，请重试"); }
  }
  return <section className="podcast-bookmarks" aria-label="时间书签">
    <h3>时间书签{editing ? " · 编辑 " + formatTime(editing.positionSeconds) : ""}</h3>
    <div className="podcast-bookmark-entry"><input aria-label={editing ? "编辑书签备注" : "书签备注"} placeholder="备注（可选）" maxLength={200} value={label} onChange={event => setLabel(event.target.value)} />
      <Button disabled={busy || loading} onClick={() => void mutate("save")}>{editing ? "保存备注" : "添加 " + formatTime(position)}</Button>
      {editing ? <Button disabled={busy} onClick={() => { setEditing(null); setLabel(""); }}>取消编辑</Button> : <Button onClick={() => void share(position)}>分享此刻</Button>}
    </div>
    {notice && <p role="status">{notice}</p>}
    {undo && <div className="podcast-bookmark-undo"><span>已删除 {formatTime(undo.positionSeconds)}</span><Button variant="ghost" disabled={busy} onClick={() => void mutate("undo")}>撤销删除</Button></div>}
    {loading ? <PodcastLoading label="正在读取书签" /> : items.length ? <ol>{items.map(item => <li key={item.id}>
      <Button variant="ghost" onClick={() => onPlayAt(item.positionSeconds)} aria-label={"跳到书签 "+formatTime(item.positionSeconds)+" "+item.label}><time>{formatTime(item.positionSeconds)}</time> {item.label || "书签"}</Button>
      <Button variant="ghost" disabled={busy} onClick={() => { setEditing(item); setLabel(item.label); }} aria-label={"编辑书签 "+formatTime(item.positionSeconds)}>编辑</Button>
      <Button variant="ghost" onClick={() => void share(item.positionSeconds)} aria-label={"分享书签 "+formatTime(item.positionSeconds)}>分享</Button>
      <Button variant="ghost" disabled={busy} onClick={() => void mutate("delete", item)} aria-label={"删除书签 "+formatTime(item.positionSeconds)}>删除</Button>
    </li>)}</ol> : <p className="podcast-section-note">暂无书签</p>}
  </section>;
}
