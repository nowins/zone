import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Pencil, RotateCcw, Search, X } from "lucide-react";
import type { MetadataEnrichmentApi } from "../hooks/useMetadataEnrichment";
import { Presence, useLastNonNull } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";
import type { ContextPayload, MetadataCandidateField, MetadataContextRecord } from "../types";
import { MetadataEditDialog } from "./MetadataEditDialog";
import { MetadataSearchDialog } from "./MetadataSearchDialog";

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
  const [activeDialog, setActiveDialog] = useState<"search" | "edit" | null>(null);
  const [status, setStatus] = useState<"idle" | "clearing">("idle");
  const [notice, setNotice] = useState("");
  const typeLabel = {
    track: "歌曲",
    album: "专辑",
    artist: "艺术家",
    playlist: "播放列表",
  }[payload.kind];

  useEffect(() => {
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

  async function clearMetadata() {
    setStatus("clearing");
    setNotice("");
    try {
      await metadata.clear(payload);
      setContext(null);
      setNotice("已恢复文件中的原始信息");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setStatus("idle");
    }
  }

  function finishDialog(nextContext: MetadataContextRecord | null, message: string) {
    setContext(nextContext);
    setActiveDialog(null);
    setNotice(message);
  }

  const searchDialogElement = activeDialog === "search" ? (
    <MetadataSearchDialog
      payload={payload}
      metadata={metadata}
      onCancel={() => setActiveDialog(null)}
      onEdit={() => setActiveDialog("edit")}
      onApplied={(nextContext) => finishDialog(nextContext, "补充信息已采用")}
    />
  ) : null;
  const editDialogElement = activeDialog === "edit" ? (
    <MetadataEditDialog
      payload={payload}
      context={context}
      metadata={metadata}
      onCancel={() => setActiveDialog(null)}
      onSearch={() => setActiveDialog("search")}
      onSaved={(nextContext) => finishDialog(nextContext, "编辑的信息已保存")}
    />
  ) : null;
  const dialogElement = searchDialogElement ?? editDialogElement;
  const lastDialogElement = useLastNonNull(dialogElement);

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

              <div className="info-metadata-actions">
                <button
                  className="info-metadata-search"
                  type="button"
                  onClick={() => setActiveDialog("search")}
                  disabled={status !== "idle"}
                >
                  <Search size={16} aria-hidden="true" />
                  查找补充信息
                </button>
                <button
                  className="info-metadata-search"
                  type="button"
                  onClick={() => setActiveDialog("edit")}
                  disabled={status !== "idle"}
                >
                  <Pencil size={15} aria-hidden="true" />
                  编辑信息
                </button>
              </div>

              {notice && <p className="info-metadata-notice" role="status">{notice}</p>}
            </div>
          )}
        </div>
      </section>
      <Presence show={dialogElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
        {dialogElement ?? lastDialogElement ?? <span style={{ display: "none" }} />}
      </Presence>
    </div>
  );
}
