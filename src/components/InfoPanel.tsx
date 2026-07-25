import { X } from "lucide-react";
import type { ContextPayload } from "../types";

export function InfoPanel({ payload, onClose }: { payload: ContextPayload; onClose: () => void }) {
  const first = payload.tracks[0];
  return (
    <div className="info-panel" onClick={onClose}>
      <section onClick={(event) => event.stopPropagation()}>
        <button className="info-close" onClick={onClose}>
          <X size={18} />
        </button>
        <h2>{payload.title}</h2>
        <p>{payload.subtitle}</p>
        <dl>
          <dt>type</dt>
          <dd>{payload.kind}</dd>
          <dt>songs</dt>
          <dd>{payload.tracks.length}</dd>
          {first && (
            <>
              <dt>album</dt>
              <dd>{first.album}</dd>
              <dt>artist</dt>
              <dd>{first.artist}</dd>
              <dt>file</dt>
              <dd>{first.file_name}</dd>
            </>
          )}
        </dl>
      </section>
    </div>
  );
}
