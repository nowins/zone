import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Pencil, RotateCcw, Search, X } from "lucide-react";
import type { MetadataEnrichmentApi } from "../hooks/useMetadataEnrichment";
import { Presence, useLastNonNull } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";
import type { ContextPayload, MetadataCandidateField, MetadataContextRecord, Track } from "../types";
import { knownDuration } from "../utils/collectionEntities";
import { appliedArtistProviderIds, selectAutomaticArtistCandidate } from "../utils/metadata";
import { bestAlbumArtist, formatTime } from "../utils/music";
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

function isLongField(field: MetadataCandidateField) {
  return field.key === "description" || field.key === "biography"
    || field.value.length > 80 || field.value.includes("\n");
}

function formatAddedDate(addedAt?: number | null) {
  if (!addedAt || !Number.isFinite(addedAt)) return null;
  const date = new Date(addedAt);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

type DetailRow = { label: string; value: string };

function trackRows(track: Track): DetailRow[] {
  const rows: DetailRow[] = [];
  if (track.album) rows.push({ label: "专辑", value: track.album });
  if (track.artist) rows.push({ label: "艺术家", value: track.artist });
  const albumArtist = track.album_artist?.trim();
  if (albumArtist && albumArtist !== track.artist.trim()) {
    rows.push({ label: "专辑艺术家", value: albumArtist });
  }
  if (track.year && track.year > 0) rows.push({ label: "年份", value: String(track.year) });
  if (track.genres?.length) rows.push({ label: "流派", value: track.genres.join(" / ") });
  if (track.track_number && track.track_number > 0) {
    rows.push({ label: "曲序", value: String(track.track_number) });
  }
  if (track.disc_number && track.disc_number > 1) {
    rows.push({ label: "碟号", value: `第 ${track.disc_number} 碟` });
  }
  if (track.duration_seconds && Number.isFinite(track.duration_seconds) && track.duration_seconds > 0) {
    rows.push({ label: "时长", value: formatTime(track.duration_seconds) });
  }
  return rows;
}

function trackFileRows(track: Track): DetailRow[] {
  const rows: DetailRow[] = [
    { label: "文件名", value: track.file_name },
    { label: "路径", value: track.path },
    { label: "格式", value: track.extension.toUpperCase() },
  ];
  const added = formatAddedDate(track.added_at);
  if (added) rows.push({ label: "添加日期", value: added });
  return rows;
}

function albumRows(payload: ContextPayload): DetailRow[] {
  const tracks = payload.tracks;
  const rows: DetailRow[] = [{ label: "专辑艺术家", value: bestAlbumArtist(tracks) }];
  const years = new Set(tracks.map((track) => track.year).filter((year): year is number => Boolean(year && year > 0)));
  if (years.size === 1) rows.push({ label: "年份", value: String([...years][0]) });
  const genres = [...new Set(tracks.flatMap((track) => track.genres ?? []))];
  if (genres.length > 0) rows.push({ label: "流派", value: genres.join(" / ") });
  rows.push({ label: "本地歌曲", value: `${tracks.length} 首` });
  const duration = knownDuration(tracks);
  if (duration !== null) rows.push({ label: "总时长", value: formatTime(duration) });
  const discs = new Set(tracks.map((track) => track.disc_number || 1));
  if (discs.size > 1) rows.push({ label: "碟数", value: `${discs.size} 张` });
  rows.push({ label: "编辑范围", value: `此专辑的 ${tracks.length} 首本地歌曲` });
  return rows;
}

function artistRows(payload: ContextPayload): DetailRow[] {
  const tracks = payload.tracks;
  const rows: DetailRow[] = [{ label: "本地歌曲", value: `${tracks.length} 首` }];
  const albums = new Set(tracks.map((track) => track.album.trim()).filter(Boolean));
  if (albums.size > 0) rows.push({ label: "本地专辑", value: `${albums.size} 张` });
  const genres = [...new Set(tracks.flatMap((track) => track.genres ?? []))];
  if (genres.length > 0) rows.push({ label: "流派", value: genres.join(" / ") });
  rows.push({ label: "编辑范围", value: `署名为${payload.title}的 ${tracks.length} 首本地歌曲` });
  return rows;
}

function DetailList({ rows }: { rows: DetailRow[] }) {
  return (
    <dl className="info-detail-list">
      {rows.map((row) => (
        <Fragment key={row.label}>
          <dt>{row.label}</dt>
          <dd title={row.value}>{row.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
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
  const [contextLoaded, setContextLoaded] = useState(false);
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
    setContextLoaded(false);
    if (!supportsMetadata) {
      setContext(null);
      return;
    }
    let cancelled = false;
    void metadata.getContext(payload)
      .then((result) => {
        if (cancelled) return;
        setContext(result);
        setContextLoaded(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setNotice(String(error));
        setContextLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [metadata.getContext, payload, supportsMetadata]);

  // Artists without any local imagery get one automatic online lookup per panel
  // mount; only exact-match candidates are applied, failures stay silent so the
  // manual 查找补充信息 flow remains the fallback.
  const autoArtistFetchRef = useRef(false);
  useEffect(() => {
    if (autoArtistFetchRef.current) return;
    if (payload.kind !== "artist" || !supportsMetadata || !contextLoaded || context || !first) return;
    if (first.artist_image_path) return;
    autoArtistFetchRef.current = true;
    void (async () => {
      try {
        const candidate = selectAutomaticArtistCandidate(
          await metadata.search(payload),
          appliedArtistProviderIds(first),
        );
        if (!candidate) return;
        const nextContext = await metadata.apply(payload, candidate);
        if (!mounted.current) return;
        setContext(nextContext);
        if (nextContext && artworkPath(nextContext.fields)) {
          setNotice("已自动补充艺术家照片");
        }
      } catch {
        // Automatic enrichment is best-effort; the manual search stays available.
      }
    })();
  }, [payload, supportsMetadata, contextLoaded, context, first, metadata]);

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

  const heroArtPath = useMemo(() => {
    if (payload.kind === "playlist" || !first) return null;
    const contextArt = context ? artworkPath(context.fields) : undefined;
    if (payload.kind === "artist") {
      return first.artist_image_path
        ?? context?.fields.find((field) => field.key === "artist_image_path")?.value
        ?? null;
    }
    return first.cover_path ?? contextArt ?? null;
  }, [payload.kind, first, context]);

  const detailRows = useMemo(() => {
    if (payload.kind === "track" && first) return trackRows(first);
    if (payload.kind === "album" && first) return albumRows(payload);
    if (payload.kind === "artist") return artistRows(payload);
    return [{ label: "本地歌曲", value: `${payload.tracks.length} 首` }];
  }, [payload, first]);

  const contextFields = useMemo(() => (
    context?.fields.filter((field) => !isArtworkField(field)) ?? []
  ), [context]);
  const shortContextFields = contextFields.filter((field) => !isLongField(field));
  const longContextFields = contextFields.filter(isLongField);

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
          <header className="info-hero">
            {payload.kind !== "playlist" && first && (
              <div className="info-hero-art">
                <Cover artPath={heroArtPath} label={payload.title} />
              </div>
            )}
            <div className="info-hero-copy">
              <span className="info-kicker">{typeLabel}</span>
              <h2 id="info-panel-title">{payload.title}</h2>
              <p className="info-hero-sub">{payload.subtitle}</p>
            </div>
          </header>

          <DetailList rows={detailRows} />

          {payload.kind === "track" && first && (
            <div className="info-file-group">
              <h3>文件</h3>
              <DetailList rows={trackFileRows(first)} />
            </div>
          )}

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
                  {shortContextFields.map((field) => (
                    <div key={field.key}>
                      <span>{field.label}</span>
                      <p>{field.value}</p>
                    </div>
                  ))}
                  {longContextFields.map((field) => (
                    <div className="info-metadata-long" key={field.key}>
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
