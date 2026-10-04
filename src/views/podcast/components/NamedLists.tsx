import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Presence, useLastNonNull } from "../../../motion/presence";
import { MOTION_DURATIONS } from "../../../motion/tokens";
import type { PodcastEpisode, PodcastFeed } from "../../../types";
import { deletePodcastPlaylist, listPodcastPlaylists, podcastPlaylistPage, reorderPodcastPlaylist, savePodcastPlaylist, updatePlaylistItem, type EpisodeSearchPage, type PodcastPlaylist, type PodcastPlaylistRules } from "../api";
import { EpisodeRow } from "./EpisodeRows";
import { ListNavigator } from "./ListNavigator";
import { PodcastEmpty, PodcastLoading } from "./primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";

const defaults: PodcastPlaylistRules = { filter: "unplayed", sort: "newest", feedIds: [], maxAgeDays: null };
const message = (error: unknown) => typeof error === "string" ? error : "操作未完成，请重试";

function ListEditor({ list, feeds, onClose, onSaved }: { list: PodcastPlaylist | "new"; feeds: PodcastFeed[]; onClose: () => void; onSaved: (list: PodcastPlaylist) => void }) {
  const existing = list === "new" ? null : list;
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState(existing?.kind ?? "manual");
  const [rules, setRules] = useState(existing?.rules ?? defaults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Dialog titleId="podcast-list-editor-title" title={existing ? "编辑播放列表" : "新建播放列表"} kicker="播客" className="podcast-collection-dialog" busy={busy} onCancel={onClose}
    onSubmit={async event => { event.preventDefault(); setBusy(true); setError(""); try { const result = await savePodcastPlaylist({ id: existing?.id, name, kind, rules, expectedUpdatedAt: existing?.updatedAt }); onSaved(result); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }}
    actions={<><Button onClick={onClose} disabled={busy}>取消</Button><Button type="submit" variant="primary" busy={busy}>保存</Button></>}>
    <div className="podcast-collection-fields">
      <label>名称<input aria-label="播放列表名称" value={name} maxLength={80} onChange={event => setName(event.target.value)} required /></label>
      <label>类型<select aria-label="播放列表类型" value={kind} disabled={Boolean(existing)} onChange={event => setKind(event.target.value as "manual" | "smart")}><option value="manual">手动添加</option><option value="smart">智能列表</option></select></label>
      {kind === "smart" ? <>
        <label>收录单集<select aria-label="智能列表筛选" value={rules.filter} onChange={event => setRules({ ...rules, filter: event.target.value })}><option value="all">全部</option><option value="unplayed">未听完</option><option value="played">已听完</option><option value="saved">稍后听</option><option value="downloaded">已下载</option></select></label>
        <label>排序<select aria-label="智能列表排序" value={rules.sort} onChange={event => setRules({ ...rules, sort: event.target.value })}><option value="newest">最新优先</option><option value="oldest">最早优先</option><option value="title">标题</option></select></label>
        <label>最近天数<input aria-label="智能列表最近天数" type="number" min={1} max={3650} placeholder="不限" value={rules.maxAgeDays ?? ""} onChange={event => setRules({ ...rules, maxAgeDays: event.target.value === "" ? null : Number(event.target.value) })} /></label>
        <fieldset className="podcast-collection-feeds"><legend>节目范围 · 不选表示全部</legend>{feeds.map(feed => <label key={feed.id}><input type="checkbox" checked={rules.feedIds.includes(feed.id)} onChange={event => setRules({ ...rules, feedIds: event.target.checked ? [...rules.feedIds, feed.id] : rules.feedIds.filter(id => id !== feed.id) })} />{feed.title}</label>)}</fieldset>
        <small>条件从完整资料库动态计算；播放时将当前结果加入待播。</small>
      </> : <small>从单集详情加入内容；播放列表会保留独立顺序。</small>}
    </div>{error ? <p role="alert">{error}</p> : null}
  </Dialog>;
}

export function PlaylistPicker({ episode, onClose }: { episode: PodcastEpisode; onClose: () => void }) {
  const [lists, setLists] = useState<PodcastPlaylist[] | null>(null);
  const [id, setId] = useState(""); const [name, setName] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { let disposed = false; void listPodcastPlaylists().then(result => { if (!disposed) { const manual = result.filter(list => list.kind === "manual"); setLists(manual); setId(manual[0]?.id ?? ""); } }).catch(reason => { if (!disposed) setError(message(reason)); }); return () => { disposed = true; }; }, []);
  return <Dialog titleId="podcast-add-list-title" title="加入播放列表" kicker={episode.feedTitle ?? "播客"} className="podcast-collection-dialog" busy={busy} onCancel={onClose}
    onSubmit={async event => { event.preventDefault(); if (!lists) return; setBusy(true); setError(""); try { let target = id; if (!target) { const created = await savePodcastPlaylist({ name, kind: "manual", rules: defaults }); target = created.id; setLists(previous => [...(previous ?? []), created]); setId(target); } await updatePlaylistItem(target, episode.id, true); onClose(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }}
    actions={<><Button onClick={onClose} disabled={busy}>取消</Button><Button type="submit" variant="primary" busy={busy} disabled={!lists || (!id && !name.trim())}>加入</Button></>}>
    {lists ? <div className="podcast-collection-fields"><label>列表<select aria-label="选择播放列表" value={id} onChange={event => setId(event.target.value)}>{lists.map(list => <option key={list.id} value={list.id}>{list.name}</option>)}<option value="">新建手动列表</option></select></label>{!id ? <label>名称<input aria-label="新列表名称" value={name} onChange={event => setName(event.target.value)} maxLength={80} required /></label> : null}</div> : <PodcastLoading label="正在读取播放列表" />}
    {error ? <p role="alert">{error}</p> : null}
  </Dialog>;
}

let rememberedList: {selected:string|null;offset:number}={selected:null,offset:0};
export function NamedLists({ vm }: { vm: PodcastViewModel }) {
  const [lists, setLists] = useState<PodcastPlaylist[] | null>(null); const [selected, setSelected] = useState<string | null>(rememberedList.selected);
  const [page, setPage] = useState<EpisodeSearchPage | null>(null); const [offset, setOffset] = useState(rememberedList.offset);
  const [revision, setRevision] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<PodcastPlaylist | "new" | null>(null); const editorSnapshot = useLastNonNull(editor);
  const [deleting, setDeleting] = useState<PodcastPlaylist | null>(null); const deletingSnapshot = useLastNonNull(deleting);
  useEffect(()=>{rememberedList={selected,offset};},[selected,offset]);
  const requestRef = useRef(0); const selectedList = lists?.find(list => list.id === selected);
  useEffect(() => { let disposed = false; void listPodcastPlaylists().then(result => { if (disposed) return; setLists(result); setSelected(old => result.some(list => list.id === old) ? old : result[0]?.id ?? null); }).catch(reason => { if (!disposed) setError(message(reason)); }); return () => { disposed = true; }; }, [revision, vm.libraryRevision]);
  useEffect(() => { const request = ++requestRef.current; setPage(null); setError(""); if (!selected) return; void podcastPlaylistPage(selected, offset).then(result => { if (requestRef.current !== request) return; if (offset > 0 && offset >= result.total) { setOffset(Math.max(0, Math.floor((result.total - 1) / 50) * 50)); return; } setPage(result); }).catch(reason => { if (requestRef.current === request) setError(message(reason)); }); return () => { requestRef.current++; }; }, [selected, offset, revision, vm.libraryRevision]);
  async function mutate(operation: () => Promise<unknown>, success = "") { if (busy) return; setBusy(true); setError(""); setNotice(""); try { await operation(); setRevision(value => value + 1); setNotice(success); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }
  async function move(episodeId: string, direction: number) {
    if (!selected) return;
    await mutate(async () => { const all: PodcastEpisode[] = []; let start = 0; let more = true; while (more) { const result = await podcastPlaylistPage(selected, start, 100); all.push(...result.episodes); start += result.episodes.length; more = result.hasMore; if (start > 500 || (more && !result.episodes.length)) throw "列表已变化，请重试"; } const ids = all.map(episode => episode.id); const index = ids.indexOf(episodeId); const target = index + direction; if (index < 0 || target < 0 || target >= ids.length) throw "列表已变化，请重试"; [ids[index], ids[target]] = [ids[target], ids[index]]; await reorderPodcastPlaylist(selected, ids); }, direction < 0 ? "已上移单集" : "已下移单集");
  }
  return <section className="podcast-named-lists">
    <div className="podcast-named-list-heading"><h2>我的列表</h2><Button variant="ghost" onClick={() => setEditor("new")}>新建列表</Button></div>
    {lists === null ? !error && <PodcastLoading label="正在读取列表" /> : lists.length === 0 ? <PodcastEmpty label="还没有播放列表" /> : <>
      <div className="podcast-named-list-layout"><ListNavigator lists={lists} selected={selected} onSelect={id => { setOffset(0); setSelected(id); setNotice(""); }} />
      <div className="podcast-named-list-content">{selectedList ? <><div className="podcast-named-list-heading"><h3>{selectedList.name}{page ? <small>{page.total} 集</small> : null}</h3><div><Button variant="primary" disabled={busy || !page?.total || !vm.onPlayPlaylist} onClick={() => void mutate(async () => { await vm.onPlayPlaylist?.(selectedList.id); vm.changeRootScreen("playlist"); })}>播放列表</Button><Button variant="ghost" disabled={busy} onClick={() => setEditor(selectedList)}>编辑</Button><Button variant="ghost" disabled={busy} onClick={() => setDeleting(selectedList)}>删除列表</Button></div></div>
        {notice ? <p className="podcast-list-notice" role="status">{notice}</p> : null}
        {!page ? !error && <PodcastLoading label="正在整理单集" /> : page.total === 0 ? <PodcastEmpty label="列表暂时没有单集，可加入内容或修改条件" /> : <>
          {page.episodes.map((episode, index) => <div key={episode.id} className="podcast-named-list-row"><EpisodeRow episode={episode} active={vm.currentEpisodeId === episode.id} isPlaying={vm.isPlaying} downloading={vm.downloadingId === episode.id} showFeed onOpen={() => vm.openEpisodeDetail(episode, "playlist")} onPlay={() => vm.playEpisode(episode)} onDownload={() => void vm.downloadEpisode(episode)} onContextMenu={event => vm.showEpisodeMenu(event, episode)} />{selectedList.kind === "manual" ? <div className="podcast-named-list-order"><Button variant="ghost" size="sm" aria-label={`上移“${episode.title}”`} disabled={busy || offset + index === 0} onClick={() => void move(episode.id, -1)}>上移</Button><Button variant="ghost" size="sm" aria-label={`下移“${episode.title}”`} disabled={busy || offset + index + 1 >= page.total} onClick={() => void move(episode.id, 1)}>下移</Button><Button variant="ghost" size="sm" aria-label={`从列表移除“${episode.title}”`} disabled={busy} onClick={() => void mutate(() => updatePlaylistItem(selectedList.id, episode.id, false), "已从列表移除单集")}>移除</Button></div> : null}</div>)}
          <div className="podcast-search-page-actions"><Button variant="ghost" disabled={offset === 0 || busy} onClick={() => setOffset(value => Math.max(0, value - 50))}>上一页</Button><span>{offset + 1}–{offset + page.episodes.length} / {page.total}</span><Button variant="ghost" disabled={!page.hasMore || busy} onClick={() => setOffset(value => value + 50)}>下一页</Button></div>
        </>}</> : null}</div></div>
    </>}
    {error ? <p role="alert">{error}<Button variant="ghost" onClick={() => setRevision(value => value + 1)}>重试</Button></p> : null}
    <Presence show={editor !== null} exitDurationMs={MOTION_DURATIONS.micro}>{editorSnapshot ? <ListEditor key={editorSnapshot === "new" ? "new" : editorSnapshot.id} list={editorSnapshot} feeds={vm.feeds} onClose={() => setEditor(null)} onSaved={list => { setSelected(list.id); setOffset(0); setRevision(value => value + 1); setEditor(null); }} /> : <span />}</Presence>
    <Presence show={deleting !== null} exitDurationMs={MOTION_DURATIONS.micro}>{deletingSnapshot ? <Dialog titleId="podcast-delete-list-title" title={`删除“${deletingSnapshot.name}”`} kicker="播放列表" className="podcast-collection-dialog" busy={busy} onCancel={() => setDeleting(null)} onSubmit={event => { event.preventDefault(); void mutate(async () => { await deletePodcastPlaylist(deletingSnapshot.id); setDeleting(null); setOffset(0); }); }} actions={<><Button disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button type="submit" variant="danger" busy={busy}>删除列表</Button></>}><p>下载、订阅和收听进度会保留。</p></Dialog> : <span />}</Presence>
  </section>;
}
