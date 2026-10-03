import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { formatTime } from "../../../utils/music";
import { addEpisodeBookmark, listEpisodeBookmarks, removeEpisodeBookmark, type PodcastBookmark } from "../api";
import { copyPodcastShareUrl, shareablePodcastEpisodeUrl } from "../format";
import type { PodcastEpisode } from "../../../types";

export function EpisodeBookmarks({ episode, position, onPlayAt }: { episode: PodcastEpisode; position: number; onPlayAt: (position: number) => void }) {
  const [items, setItems] = useState<PodcastBookmark[]>([]), [label, setLabel] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const generation = useRef(0);
  useEffect(() => { const epoch = ++generation.current; setItems([]); setNotice(""); void listEpisodeBookmarks(episode.id).then(value => { if (epoch === generation.current) setItems(value); }).catch(() => { if (epoch === generation.current) setNotice("书签读取失败"); }); return () => { generation.current++; }; }, [episode.id]);
  async function mutate(remove?: string) {
    if (busy) return; const epoch = ++generation.current; setBusy(true); setNotice("");
    try { const value = remove ? await removeEpisodeBookmark(episode.id, remove) : await addEpisodeBookmark(episode.id, Math.max(0, position), label); if (epoch === generation.current) { setItems(value); setLabel(""); } }
    catch (reason) { if (epoch === generation.current) setNotice(String(reason)); }
    finally { if (epoch === generation.current) setBusy(false); }
  }
  async function share(seconds: number) {
    const url = shareablePodcastEpisodeUrl(episode); if (!url) { setNotice("这集没有可分享的链接"); return; }
    const link = new URL(url); link.hash = `t=${Math.floor(Math.max(0, seconds))}`;
    try { await copyPodcastShareUrl(`${episode.title}\n${formatTime(seconds)}\n${link.href}`); setNotice("已复制单集链接和时间；接收软件可能需要手动定位"); }
    catch { setNotice("复制失败，请重试"); }
  }
  return <section className="podcast-bookmarks" aria-label="时间书签">
    <h3>时间书签</h3>
    <div className="podcast-bookmark-entry"><input aria-label="书签备注" placeholder="备注（可选）" maxLength={200} value={label} onChange={event => setLabel(event.target.value)} /><Button disabled={busy} onClick={() => void mutate()}>添加 {formatTime(position)}</Button><Button onClick={() => void share(position)}>分享此刻</Button></div>
    {notice && <p role="status">{notice}</p>}
    {items.length ? <ol>{items.map(item => <li key={item.id}><Button variant="ghost" onClick={() => onPlayAt(item.positionSeconds)} aria-label={`跳到书签 ${formatTime(item.positionSeconds)} ${item.label}`}><time>{formatTime(item.positionSeconds)}</time> {item.label || "书签"}</Button><Button variant="ghost" onClick={() => void share(item.positionSeconds)} aria-label={`分享书签 ${formatTime(item.positionSeconds)}`}>分享</Button><Button variant="ghost" disabled={busy} onClick={() => void mutate(item.id)} aria-label={`删除书签 ${formatTime(item.positionSeconds)}`}>删除</Button></li>)}</ol> : <p className="podcast-section-note">在收听的位置留下备注，稍后点击即可返回。</p>}
  </section>;
}
