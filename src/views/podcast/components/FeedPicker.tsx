import { useState } from "react";
import { Button } from "../../../components/Button";
import type { PodcastFeed } from "../../../types";

export function FeedPicker({ feeds, selected, onChange, disabled = false, legend = "选择节目" }: {
  feeds: PodcastFeed[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean; legend?: string;
}) {
  const [query, setQuery] = useState("");
  const visible = feeds.filter(feed => `${feed.title} ${feed.author ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selectedCount = feeds.filter(feed => selected.includes(feed.id)).length;
  function selectVisible(add: boolean) {
    const visibleIds = new Set(visible.map(feed => feed.id));
    onChange(add ? [...new Set([...selected, ...visibleIds])] : selected.filter(id => !visibleIds.has(id)));
  }
  return <fieldset className="podcast-feed-picker" disabled={disabled}>
    <legend>{legend}</legend>
    <input type="search" aria-label="搜索节目范围" placeholder="搜索节目或作者" value={query} onChange={event => setQuery(event.target.value)} />
    <div className="podcast-feed-picker-tools"><span role="status">已选 {selectedCount} / {feeds.length}</span>
      <Button variant="ghost" size="sm" disabled={!visible.length} onClick={() => selectVisible(true)}>选中可见节目</Button>
      <Button variant="ghost" size="sm" disabled={!visible.some(feed => selected.includes(feed.id))} onClick={() => selectVisible(false)}>取消可见选择</Button>
    </div>
    <div className="podcast-collection-feeds">{visible.map(feed => <label key={feed.id}>
      <input type="checkbox" checked={selected.includes(feed.id)} onChange={event => onChange(event.target.checked ? [...selected, feed.id] : selected.filter(id => id !== feed.id))} />{feed.title}
    </label>)}{!visible.length && <p>没有匹配的节目</p>}</div>
  </fieldset>;
}
