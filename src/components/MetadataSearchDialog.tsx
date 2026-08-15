import { useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Search } from "lucide-react";
import type { MetadataEnrichmentApi } from "../hooks/useMetadataEnrichment";
import type {
  ContextPayload,
  MetadataCandidate,
  MetadataCandidateField,
  MetadataContextRecord,
} from "../types";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { Dialog } from "./Dialog";

function artworkPath(fields: MetadataCandidateField[]) {
  return fields.find((field) => (
    field.key === "artist_image_path" || field.key === "album_cover_path"
  ))?.value;
}

function typeLabel(payload: ContextPayload) {
  return payload.kind === "track" ? "歌曲" : payload.kind === "album" ? "专辑" : "艺术家";
}

export function MetadataSearchDialog({
  payload,
  metadata,
  onCancel,
  onEdit,
  onApplied,
}: {
  payload: ContextPayload;
  metadata: MetadataEnrichmentApi;
  onCancel: () => void;
  onEdit: () => void;
  onApplied: (context: MetadataContextRecord | null) => void;
}) {
  const [query, setQuery] = useState(payload.title);
  const [candidates, setCandidates] = useState<MetadataCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "searching" | "applying">("idle");
  const [notice, setNotice] = useState("");
  const selected = useMemo(
    () => candidates.find((candidate) => candidate.id === selectedId) ?? null,
    [candidates, selectedId],
  );
  const first = payload.tracks[0];
  const label = typeLabel(payload);

  async function runSearch(event?: React.FormEvent) {
    event?.preventDefault();
    if (!query.trim() || status !== "idle") return;
    setStatus("searching");
    setNotice("");
    try {
      const result = await metadata.search(payload, query);
      setCandidates(result);
      setSelectedId(result[0]?.id ?? null);
      if (result.length === 0) setNotice("没有找到可采用的信息");
    } catch (error) {
      setCandidates([]);
      setSelectedId(null);
      setNotice(String(error));
    } finally {
      setStatus("idle");
    }
  }

  async function applyCandidate(candidate: MetadataCandidate) {
    if (status !== "idle") return;
    setStatus("applying");
    setNotice("");
    try {
      const context = await metadata.apply(payload, candidate);
      onApplied(context);
    } catch (error) {
      setNotice(String(error));
      setStatus("idle");
    }
  }

  return (
    <Dialog
      titleId="metadata-search-title"
      kicker="音乐信息"
      title={"查找" + label + "信息"}
      className="metadata-dialog metadata-search-dialog"
      overlayClassName="metadata-dialog-overlay"
      onCancel={onCancel}
      onSubmit={runSearch}
    >
      <div className="metadata-search-summary">
          <div className="metadata-dialog-identity">
            <Cover artPath={first?.cover_path} label={payload.title} size="large" />
            <div>
              <strong>{payload.title}</strong>
              <span>{payload.subtitle}</span>
              <small>{payload.tracks.length} 首歌曲</small>
            </div>
          </div>
          <label className="metadata-search-field">
            <span>搜索</span>
            <div>
              <input
                autoFocus
                maxLength={500}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`输入${label}名称`}
              />
              <Search size={17} aria-hidden="true" />
            </div>
          </label>
      </div>

        {candidates.length > 0 && (
          <div className="metadata-search-results" role="listbox" aria-label="查找结果">
            {candidates.map((candidate) => {
              const selectedCandidate = candidate.id === selectedId;
              const imagePath = artworkPath(candidate.fields);
              return (
                <button
                  key={candidate.id}
                  className={selectedCandidate ? "selected" : ""}
                  type="button"
                  role="option"
                  aria-selected={selectedCandidate}
                  onClick={() => setSelectedId(candidate.id)}
                  onDoubleClick={() => void applyCandidate(candidate)}
                >
                  {imagePath ? (
                    <img src={convertFileSrc(imagePath)} alt="" draggable={false} />
                  ) : (
                    <Cover artPath={first?.cover_path} label={candidate.title} size="mini" />
                  )}
                  <span>
                    <strong>{candidate.title}</strong>
                    <small>{candidate.subtitle}</small>
                    <em>{candidate.providerName} · 匹配度 {candidate.confidence}%</em>
                  </span>
                </button>
              );
            })}
          </div>
        )}

      {notice && <p className="metadata-dialog-notice" role="status">{notice}</p>}

      <div className="metadata-dialog-footer">
        <Button onClick={onEdit}>编辑信息</Button>
        <div className="playlist-dialog-actions">
          {selected ? (
            <Button
              variant="primary"
              busy={status === "applying"}
              onClick={() => void applyCandidate(selected)}
              disabled={status !== "idle"}
            >
              采用
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              busy={status === "searching"}
              disabled={!query.trim() || status !== "idle"}
            >
              搜索
            </Button>
          )}
          <Button onClick={onCancel}>取消</Button>
        </div>
      </div>
    </Dialog>
  );
}
