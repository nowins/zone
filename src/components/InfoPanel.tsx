import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { FileJson2, LoaderCircle, RotateCcw, Search, X } from "lucide-react";
import type { MetadataEnrichmentApi } from "../hooks/useMetadataEnrichment";
import type {
  ContextPayload,
  MetadataCandidate,
  MetadataCandidateField,
  MetadataContextRecord,
} from "../types";

function artworkPath(fields: MetadataCandidateField[]) {
  return fields.find((field) => (
    field.key === "artist_image_path" || field.key === "album_cover_path"
  ))?.value;
}

function isArtworkField(field: MetadataCandidateField) {
  return field.key === "artist_image_path" || field.key === "album_cover_path";
}

export function InfoPanel({
  payload,
  metadata,
  onClose,
}: {
  payload: ContextPayload;
  metadata: MetadataEnrichmentApi;
  onClose: () => void;
}) {
  const first = payload.tracks[0];
  const supportsMetadata = payload.kind !== "playlist" && payload.tracks.length > 0;
  const [context, setContext] = useState<MetadataContextRecord | null>(null);
  const [candidates, setCandidates] = useState<MetadataCandidate[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "applying" | "clearing">("idle");
  const [notice, setNotice] = useState("");
  const typeLabel = {
    track: "歌曲",
    album: "专辑",
    artist: "艺术家",
    playlist: "播放列表",
  }[payload.kind];

  useEffect(() => {
    setCandidates([]);
    setNotice("");
    if (!supportsMetadata) {
      setContext(null);
      return;
    }
    let cancelled = false;
    void metadata.getContext(payload)
      .then((result) => {
        if (!cancelled) setContext(result);
      })
      .catch((error) => {
        if (!cancelled) setNotice(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [metadata, payload, supportsMetadata]);

  async function searchMetadata() {
    setStatus("loading");
    setNotice("");
    try {
      const result = await metadata.search(payload);
      setCandidates(result);
      if (result.length === 0) {
        setNotice("未找到匹配度足够的补充信息");
      }
    } catch (error) {
      setNotice(String(error));
    } finally {
      setStatus("idle");
    }
  }

  async function applyCandidate(candidate: MetadataCandidate) {
    setStatus("applying");
    setNotice("");
    try {
      const result = await metadata.apply(payload, candidate);
      setContext(result);
      setCandidates([]);
      setNotice("补充信息已采用");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setStatus("idle");
    }
  }

  async function clearMetadata() {
    setStatus("clearing");
    setNotice("");
    try {
      await metadata.clear(payload);
      setContext(null);
      setCandidates([]);
      setNotice("已恢复文件中的原始信息");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setStatus("idle");
    }
  }

  return (
    <div className="info-panel" onClick={onClose}>
      <section onClick={(event) => event.stopPropagation()}>
        <button className="info-close" onClick={onClose} aria-label="关闭信息面板">
          <X size={18} />
        </button>
        <div className="info-panel-scroll">
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

          {supportsMetadata && (
            <div className="info-metadata">
              <header>
                <div>
                  <span>补充信息</span>
                  <strong>{context ? `来自 ${context.providerName}` : "使用独立覆盖层，不修改音乐文件"}</strong>
                </div>
                {context && (
                  <button
                    type="button"
                    onClick={clearMetadata}
                    disabled={status !== "idle"}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    恢复本地信息
                  </button>
                )}
              </header>

              {context && (
                <div className="info-metadata-applied">
                  {artworkPath(context.fields) && (
                    <img
                      src={convertFileSrc(artworkPath(context.fields)!)}
                      alt=""
                      draggable={false}
                    />
                  )}
                  {context.fields.filter((field) => !isArtworkField(field)).map((field) => (
                    <div key={field.key}>
                      <span>{field.label}</span>
                      <p>{field.value}</p>
                    </div>
                  ))}
                  <small title={context.sourcePath}>{context.sourcePath}</small>
                </div>
              )}

              <button
                className="info-metadata-search"
                type="button"
                onClick={searchMetadata}
                disabled={status !== "idle"}
              >
                {status === "loading" ? (
                  <LoaderCircle className="metadata-spinner" size={16} aria-hidden="true" />
                ) : (
                  <Search size={16} aria-hidden="true" />
                )}
                {status === "loading" ? "正在查找" : "查找补充信息"}
              </button>

              {candidates.length > 0 && (
                <div className="info-metadata-candidates">
                  {candidates.map((candidate) => (
                    <article key={candidate.id}>
                      <FileJson2 size={20} aria-hidden="true" />
                      <div>
                        <strong>{candidate.title}</strong>
                        <span>{candidate.providerName} · 匹配度 {candidate.confidence}%</span>
                        <em>{candidate.subtitle}</em>
                        {artworkPath(candidate.fields) && (
                          <img
                            className="info-metadata-candidate-art"
                            src={convertFileSrc(artworkPath(candidate.fields)!)}
                            alt=""
                            draggable={false}
                          />
                        )}
                        <dl>
                          {candidate.fields.filter((field) => !isArtworkField(field)).map((field) => (
                            <div key={field.key}>
                              <dt>{field.label}</dt>
                              <dd>{field.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                      <button
                        type="button"
                        onClick={() => applyCandidate(candidate)}
                        disabled={status !== "idle"}
                      >
                        采用
                      </button>
                    </article>
                  ))}
                </div>
              )}

              {notice && <p className="info-metadata-notice" role="status">{notice}</p>}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
