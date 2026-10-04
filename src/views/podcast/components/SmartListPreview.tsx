import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { previewPodcastPlaylist, type EpisodeSearchPage, type PodcastPlaylistRules } from "../api";
import { PodcastLoading } from "./primitives";

export function SmartListPreview({ rules }: { rules: PodcastPlaylistRules }) {
  const [page, setPage] = useState<EpisodeSearchPage | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    setPage(null); setError("");
    const timer = window.setTimeout(() => void previewPodcastPlaylist(rules).then(result => { if (!disposed) setPage(result); }).catch(reason => { if (!disposed) setError(typeof reason === "string" ? reason : "预览未完成"); }), 200);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [rules, revision]);
  const filters: Record<string, string> = { all: "全部单集", unplayed: "未听完", played: "已听完", saved: "稍后听", downloaded: "已下载" };
  const sorts: Record<string, string> = { newest: "最新优先", oldest: "最早优先", title: "按标题" };
  return <section className="podcast-smart-preview" aria-label="智能列表预览">
    <p className="podcast-smart-summary">{filters[rules.filter]} · {rules.feedIds.length ? `${rules.feedIds.length} 个节目` : "全部节目"} · {rules.maxAgeDays ? `最近 ${rules.maxAgeDays} 天` : "不限时间"} · {sorts[rules.sort]}</p>
    {error ? <p role="alert">{error}<Button variant="ghost" onClick={() => setRevision(value => value + 1)}>重试预览</Button></p> : !page ? <PodcastLoading label="正在计算完整资料库" /> : <>
      <p role="status">匹配 {page.total} 集{page.total > 500 ? " · 超过待播上限，请缩小条件" : ""}</p>
      {page.total ? <ol>{page.episodes.map(episode => <li key={episode.id}>{episode.title}</li>)}</ol> : <small>暂无匹配，可调整收录状态或节目范围。</small>}
    </>}
  </section>;
}
