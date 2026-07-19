import { X } from "lucide-react";
import type { ContextPayload } from "../types";

export function InfoPanel({ payload, onClose }: { payload: ContextPayload; onClose: () => void }) {
  const first = payload.tracks[0];
  const typeLabel = {
    track: "歌曲",
    album: "专辑",
    artist: "艺术家",
    playlist: "播放列表",
  }[payload.kind];

  return (
    <div className="info-panel" onClick={onClose}>
      <section onClick={(event) => event.stopPropagation()}>
        <button className="info-close" onClick={onClose}>
          <X size={18} />
        </button>
        <h2>{payload.title}</h2>
        <p>{payload.subtitle}</p>
        <dl>
          <dt>类型</dt>
          <dd>{typeLabel}</dd>
          <dt>歌曲</dt>
          <dd>{payload.tracks.length}</dd>
          {first && (
            <>
              <dt>专辑</dt>
              <dd>{first.album}</dd>
              <dt>艺术家</dt>
              <dd>{first.artist}</dd>
              <dt>文件</dt>
              <dd>{first.file_name}</dd>
            </>
          )}
        </dl>
      </section>
    </div>
  );
}
