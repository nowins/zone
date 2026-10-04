import { useState } from "react";
import { Button } from "../../../components/Button";
import type { PodcastPlaylist } from "../api";

export function ListNavigator({ lists, selected, onSelect }: { lists: PodcastPlaylist[]; selected: string | null; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const visible = lists.filter(list => list.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const current = lists.find(list => list.id === selected);
  return <aside className="podcast-list-index">
    <input type="search" aria-label="搜索我的列表" placeholder="搜索列表" value={query} onChange={event => setQuery(event.target.value)} />
    <select className="podcast-list-select" aria-label="当前播放列表" value={selected ?? ""} onChange={event => onSelect(event.target.value)}>
      {current && !visible.some(list => list.id === current.id) ? <option value={current.id}>{current.name} · 当前</option> : null}
      {visible.map(list => <option key={list.id} value={list.id}>{list.name}{list.kind === "smart" ? " · 智能" : ""}</option>)}
    </select>
    <nav className="podcast-named-list-nav" aria-label="选择播放列表">{visible.map(list => <Button key={list.id} variant="ghost" aria-pressed={selected === list.id} title={list.name} onClick={() => onSelect(list.id)}><span>{list.name}</span>{list.kind === "smart" ? <small>智能</small> : null}</Button>)}</nav>
    {!visible.length ? <p className="podcast-list-index-empty" role="status">没有匹配的列表</p> : null}
  </aside>;
}
