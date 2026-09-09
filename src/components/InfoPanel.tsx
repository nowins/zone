import { useEffect, useRef, useState } from "react";
import { Pencil, RotateCcw, Search, X } from "lucide-react";
import type { MetadataEnrichmentApi } from "../hooks/useMetadataEnrichment";
import { Presence, useLastNonNull } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";
import type { ContextPayload, MetadataCandidateField, MetadataContextRecord } from "../types";
import { MetadataEditDialog } from "./MetadataEditDialog";
import { MetadataSearchDialog } from "./MetadataSearchDialog";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { useModalFocus } from "../hooks/useModalFocus";

function artworkPath(fields: MetadataCandidateField[]) {
  return fields.find((field) => (
    field.key === "artist_image_path" || field.key === "album_cover_path"
  ))?.value;
}

function isArtworkField(field: MetadataCandidateField) {
  return field.key === "artist_image_path" || field.key === "album_cover_path";
}

type InfoPanelProps = {
  payload: ContextPayload;
  metadata: MetadataEnrichmentApi;
  onClose: () => void;
};

export function InfoPanel(props: InfoPanelProps) {
  const identity = JSON.stringify([props.payload.kind, props.payload.targetId, props.payload.tracks.map(track => track.id)]);
  return <EntityInfoPanel key={identity} {...props} />;
}

function EntityInfoPanel({
  payload,
  metadata,
  onClose,
}: InfoPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const mounted = useRef(false);
  useModalFocus(panelRef);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
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
    setContext(null);
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
  }, [metadata.getContext, payload, supportsMetadata]);

  async function clearMetadata() {
    setStatus("clearing");
    setNotice("");
    try {
      await metadata.clear(payload);
      if (!mounted.current) return;
      setContext(null);
      setNotice("已恢复文件中的原始信息");
    } catch (error) {
      if (mounted.current) setNotice(String(error));
    } finally {
      if (mounted.current) setStatus("idle");
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
      <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="info-panel-title" tabIndex={-1}
        onKeyDown={event => { if (event.key === "Escape" && !activeDialog) { event.stopPropagation(); onClose(); } }}
        onClick={(event) => event.stopPropagation()}>
        <button className="info-close" onClick={onClose} aria-label="关闭信息面板">
          <X size={18} />
        </button>
        <div className="info-panel-scroll">
          <h2 id="info-panel-title">{payload.title}</h2>
          <p>{payload.subtitle}</p>
          <dl>
            <dt>类型</dt>
            <dd>{typeLabel}</dd>
            <dt>{payload.kind === "track" ? "文件数量" : "本地歌曲"}</dt>
            <dd>{payload.tracks.length}</dd>
            {first && payload.kind === "track" && (
              <>
                <dt>专辑</dt>
                <dd>{first.album}</dd>
                <dt>艺术家</dt>
                <dd>{first.artist}</dd>
                <dt>文件</dt>
                <dd>{first.file_name}</dd>
                <dt>路径</dt>
                <dd>{first.path}</dd>
                <dt>格式</dt>
                <dd>{first.extension.toUpperCase()}</dd>
              </>
            )}
            {payload.kind === "album" && first && <>
              <dt>专辑艺术家</dt><dd>{first.album_artist || first.artist}</dd>
              <dt>编辑范围</dt><dd>此专辑的 {payload.tracks.length} 首本地歌曲</dd>
            </>}
            {payload.kind === "artist" && <><dt>编辑范围</dt><dd>署名为{payload.title}的 {payload.tracks.length} 首本地歌曲</dd></>}
          </dl>

          {supportsMetadata && (
            <div className="info-metadata">
              <header>
                <div>
                  <span>补充信息</span>
                  <strong>{context ? `来自 ${context.providerName}` : "使用独立覆盖层，不修改音乐文件"}</strong>
                </div>
                {context && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearMetadata}
                    disabled={status !== "idle"}
                    icon={<RotateCcw size={14} aria-hidden="true" />}
                  >
                    恢复本地信息
                  </Button>
                )}
              </header>

              {context && (
                <div className="info-metadata-applied">
                  {artworkPath(context.fields) && (
                    <Cover artPath={artworkPath(context.fields)} label={payload.title} />
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
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setActiveDialog("search")}
                  disabled={status !== "idle"}
                  icon={<Search size={16} aria-hidden="true" />}
                >
                  查找补充信息
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setActiveDialog("edit")}
                  disabled={status !== "idle"}
                  icon={<Pencil size={15} aria-hidden="true" />}
                >
                  编辑信息
                </Button>
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
