import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Presence, useLastNonNull } from "../../../motion/presence";
import { MOTION_DURATIONS } from "../../../motion/tokens";
import type { PodcastFeed } from "../../../types";
import { deleteShowGroup, listShowGroups, saveShowGroup, type PodcastShowGroup } from "../api";
import { FeedPicker } from "./FeedPicker";
import { PodcastLoading } from "./primitives";

let previousSelection = "";
const errorMessage = (reason: unknown) => typeof reason === "string" ? reason : "节目分组读取或保存失败，请重试";
function GroupEditor({ group, feeds, onClose, onSaved }: { group: PodcastShowGroup | "new"; feeds: PodcastFeed[]; onClose: () => void; onSaved: (group: PodcastShowGroup | null) => void }) {
  const existing = group === "new" ? null : group;
  const [name, setName] = useState(existing?.name ?? ""); const [ids, setIds] = useState(existing?.feedIds ?? []);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [confirmingDelete, setConfirmingDelete] = useState(false);
  return <Dialog titleId="podcast-group-title" title={confirmingDelete ? `删除“${existing?.name}”` : existing ? "编辑节目分组" : "新建节目分组"} kicker="资料库" className="podcast-collection-dialog" busy={busy} onCancel={onClose}
    onSubmit={async event => { event.preventDefault(); setBusy(true); setError(""); try { if (confirmingDelete && existing) { await deleteShowGroup(existing.id); onSaved(null); } else { onSaved(await saveShowGroup({ id: existing?.id, name, feedIds: ids, expectedUpdatedAt: existing?.updatedAt })); } } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } }}
    actions={<>{existing && !confirmingDelete ? <Button variant="ghost" disabled={busy} onClick={() => setConfirmingDelete(true)}>删除分组</Button> : null}<Button disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant={confirmingDelete ? "danger" : "primary"} busy={busy}>{confirmingDelete ? "删除分组" : "保存"}</Button></>}>
    {confirmingDelete ? <p>节目仍会保持关注，单集、下载和收听进度会保留。</p> : <div className="podcast-collection-fields"><label>名称<input aria-label="节目分组名称" maxLength={80} value={name} onChange={event => setName(event.target.value)} required /></label><FeedPicker feeds={feeds} selected={ids} onChange={setIds} disabled={busy} /><small>一个节目可以加入多个分组。</small></div>}
    {error ? <p role="alert">{error}</p> : null}
  </Dialog>;
}

function ShowGroupPicker({ feed, onClose }: { feed: PodcastFeed; onClose: () => void }) {
  const [groups, setGroups] = useState<PodcastShowGroup[] | null>(null);
  const [id, setId] = useState(""); const [name, setName] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => { let disposed = false; setError(""); void listShowGroups().then(value => { if (!disposed) setGroups(value); }).catch(reason => { if (!disposed) setError(errorMessage(reason)); }); return () => { disposed = true; }; }, [revision]);
  const target = groups?.find(group => group.id === id);
  const alreadyAdded = target?.feedIds.includes(feed.id);
  return <Dialog titleId="podcast-show-group-picker" kicker={feed.title} title="加入节目分组" className="podcast-collection-dialog" busy={busy} onCancel={onClose}
    onSubmit={async event => { event.preventDefault(); if (!groups || busy) return; setBusy(true); setError(""); try {
      if (!alreadyAdded) await saveShowGroup({ id: target?.id, name: target?.name ?? name, feedIds: [...new Set([...(target?.feedIds ?? []), feed.id])], expectedUpdatedAt: target?.updatedAt });
      onClose();
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } }}
    actions={<><Button onClick={onClose} disabled={busy}>取消</Button><Button type="submit" variant="primary" busy={busy} disabled={!groups || (!id && !name.trim())}>{alreadyAdded ? "完成" : "加入"}</Button></>}>
    {groups ? <div className="podcast-collection-fields"><label>分组<select aria-label="选择节目分组" disabled={busy} value={id} onChange={event => setId(event.target.value)}><option value="">新建分组</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}{group.feedIds.includes(feed.id) ? " · 已加入" : ""}</option>)}</select></label>
      {!id && <label>名称<input aria-label="新分组名称" maxLength={80} required disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label>}
      {alreadyAdded && <p role="status">这个节目已在所选分组中</p>}</div> : !error && <PodcastLoading label="正在读取分组" />}
    {error && <p role="alert">{error}{!groups && <Button onClick={() => setRevision(value => value + 1)}>重试</Button>}</p>}
  </Dialog>;
}

export function ShowGroupAction({ feed }: { feed: PodcastFeed }) {
  const [open, setOpen] = useState(false);
  return <><Button variant="ghost" onClick={() => setOpen(true)}>加入分组</Button>
    <Presence show={open} exitDurationMs={MOTION_DURATIONS.micro}><ShowGroupPicker key={feed.id} feed={feed} onClose={() => setOpen(false)} /></Presence></>;
}

export function ShowGroups({ feeds, revision, onFilter }: { feeds: PodcastFeed[]; revision: number; onFilter: (ids: ReadonlySet<string> | null) => void }) {
  const [groups, setGroups] = useState<PodcastShowGroup[]>([]); const [selected, setSelected] = useState(previousSelection);
  const [reload, setReload] = useState(0); const [ready, setReady] = useState(false); const [error, setError] = useState("");
  const [editor, setEditor] = useState<PodcastShowGroup | "new" | null>(null); const snapshot = useLastNonNull(editor);
  useEffect(() => { let disposed = false; void listShowGroups().then(result => { if (disposed) return; setGroups(result); setReady(true); setError(""); setSelected(previous => result.some(group => group.id === previous) ? previous : ""); }).catch(reason => { if (!disposed) setError(errorMessage(reason)); }); return () => { disposed = true; }; }, [revision, reload]);
  useEffect(() => { if (!ready) return; previousSelection = selected; const group = groups.find(group => group.id === selected); onFilter(group ? new Set(group.feedIds) : null); }, [groups, selected, ready, onFilter]);
  const group = groups.find(group => group.id === selected);
  return <div className="podcast-show-groups">
    <label>节目分组<select aria-label="节目分组" value={selected} onChange={event => setSelected(event.target.value)} disabled={!ready}><option value="">全部节目</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name} · {feeds.filter(feed => group.feedIds.includes(feed.id)).length}</option>)}</select></label>
    <Button variant="ghost" onClick={() => setEditor("new")}>新建分组</Button>{group ? <Button variant="ghost" onClick={() => setEditor(group)}>编辑分组</Button> : null}
    {error ? <p role="alert">{error}<Button variant="ghost" onClick={() => setReload(value => value + 1)}>重试</Button></p> : null}
    <Presence show={editor !== null} exitDurationMs={MOTION_DURATIONS.micro}>{snapshot ? <GroupEditor key={snapshot === "new" ? "new" : snapshot.id} group={snapshot} feeds={feeds} onClose={() => setEditor(null)} onSaved={result => { setSelected(result?.id ?? ""); setEditor(null); setReload(value => value + 1); }} /> : <span />}</Presence>
  </div>;
}
