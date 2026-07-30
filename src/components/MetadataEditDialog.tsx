import { useEffect, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { MetadataEnrichmentApi } from "../hooks/useMetadataEnrichment";
import type {
  ContextPayload,
  MetadataContextRecord,
  MetadataManualField,
} from "../types";
import { Cover } from "./Cover";

type Draft = Record<string, string>;

function contextValues(context: MetadataContextRecord | null) {
  return Object.fromEntries(context?.fields.map((field) => [field.key, field.value]) ?? []);
}

function initialDraft(payload: ContextPayload, context: MetadataContextRecord | null): Draft {
  const first = payload.tracks[0];
  const saved = contextValues(context);
  if (payload.kind === "track") {
    return {
      title: saved.title ?? first?.title ?? payload.title,
      artist: saved.artist ?? first?.artist ?? payload.subtitle,
      album: saved.album ?? first?.album ?? "",
      album_artist: saved.album_artist ?? first?.album_artist ?? "",
      track_number: saved.track_number ?? String(first?.track_number ?? ""),
      disc_number: saved.disc_number ?? String(first?.disc_number ?? ""),
      year: saved.year ?? String(first?.year ?? ""),
      genres: saved.genres ?? first?.genres?.join("、") ?? "",
      description: saved.description ?? "",
    };
  }
  if (payload.kind === "album") {
    return {
      title: saved.title ?? payload.title,
      artist: saved.artist ?? first?.album_artist ?? first?.artist ?? payload.subtitle,
      year: saved.year ?? String(first?.year ?? ""),
      genres: saved.genres ?? first?.genres?.join("、") ?? "",
      description: saved.description ?? "",
    };
  }
  return {
    name: saved.name ?? payload.title,
    aliases: saved.aliases ?? "",
    identities: saved.identities ?? "",
    biography: saved.biography ?? "",
  };
}

function splitList(value: string) {
  return value
    .split(/[、,，;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toFields(draft: Draft): MetadataManualField[] {
  const fields: MetadataManualField[] = [];
  for (const [key, raw] of Object.entries(draft)) {
    const value = raw.trim();
    if (!value) continue;
    if (matchesNumberField(key)) {
      const number = Number.parseInt(value, 10);
      if (Number.isFinite(number) && number > 0) fields.push({ key, value: number });
      continue;
    }
    if (matchesListField(key)) {
      const items = splitList(value);
      if (items.length > 0) fields.push({ key, value: items });
      continue;
    }
    fields.push({ key, value });
  }
  return fields;
}

function matchesNumberField(key: string) {
  return key === "track_number" || key === "disc_number" || key === "year";
}

function matchesListField(key: string) {
  return key === "genres" || key === "aliases" || key === "identities";
}

function Field({
  draft,
  field,
  label,
  onChange,
  multiline = false,
}: {
  draft: Draft;
  field: string;
  label: string;
  onChange: (field: string, value: string) => void;
  multiline?: boolean;
}) {
  return (
    <label className={multiline ? "metadata-edit-wide metadata-edit-long" : ""}>
      <span>{label}</span>
      {multiline ? (
        <textarea
          value={draft[field] ?? ""}
          onChange={(event) => onChange(field, event.target.value)}
          maxLength={20_000}
        />
      ) : (
        <input
          value={draft[field] ?? ""}
          onChange={(event) => onChange(field, event.target.value)}
          inputMode={matchesNumberField(field) ? "numeric" : undefined}
          maxLength={matchesNumberField(field) ? 5 : 500}
        />
      )}
    </label>
  );
}

export function MetadataEditDialog({
  payload,
  context,
  metadata,
  onCancel,
  onSearch,
  onSaved,
}: {
  payload: ContextPayload;
  context: MetadataContextRecord | null;
  metadata: MetadataEnrichmentApi;
  onCancel: () => void;
  onSearch: () => void;
  onSaved: (context: MetadataContextRecord | null) => void;
}) {
  const [draft, setDraft] = useState(() => initialDraft(payload, context));
  const [status, setStatus] = useState<"idle" | "saving">("idle");
  const [notice, setNotice] = useState("");
  const fields = useMemo(() => toFields(draft), [draft]);
  const first = payload.tracks[0];
  const label = payload.kind === "track" ? "歌曲" : payload.kind === "album" ? "专辑" : "艺术家";

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  function updateField(field: string, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (fields.length === 0 || status !== "idle") return;
    setStatus("saving");
    setNotice("");
    try {
      const nextContext = await metadata.edit(payload, fields);
      onSaved(nextContext);
    } catch (error) {
      setNotice(String(error));
      setStatus("idle");
    }
  }

  return (
    <div
      className="playlist-dialog-overlay metadata-dialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onCancel();
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <form
        className="playlist-dialog metadata-dialog metadata-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="metadata-edit-title"
        onSubmit={save}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="playlist-dialog-kicker">音乐信息</span>
        <h2 id="metadata-edit-title">编辑{label}信息</h2>

        <div className="metadata-edit-body">
          <div className="metadata-edit-art">
            <Cover artPath={first?.cover_path} label={payload.title} size="large" />
            <small>信息保存在 Zone，不会写入音乐文件</small>
          </div>
          <div className="metadata-edit-grid">
            {payload.kind === "track" && (
              <>
                <Field draft={draft} field="title" label="标题" onChange={updateField} />
                <Field draft={draft} field="artist" label="歌曲艺术家" onChange={updateField} />
                <Field draft={draft} field="album" label="专辑" onChange={updateField} />
                <Field draft={draft} field="album_artist" label="专辑艺术家" onChange={updateField} />
                <Field draft={draft} field="track_number" label="曲序" onChange={updateField} />
                <Field draft={draft} field="disc_number" label="碟号" onChange={updateField} />
                <Field draft={draft} field="year" label="年份" onChange={updateField} />
                <Field draft={draft} field="genres" label="流派" onChange={updateField} />
                <Field draft={draft} field="description" label="介绍" onChange={updateField} multiline />
              </>
            )}
            {payload.kind === "album" && (
              <>
                <Field draft={draft} field="title" label="标题" onChange={updateField} />
                <Field draft={draft} field="artist" label="专辑艺术家" onChange={updateField} />
                <Field draft={draft} field="year" label="年份" onChange={updateField} />
                <Field draft={draft} field="genres" label="流派" onChange={updateField} />
                <Field draft={draft} field="description" label="专辑介绍" onChange={updateField} multiline />
              </>
            )}
            {payload.kind === "artist" && (
              <>
                <Field draft={draft} field="name" label="艺术家" onChange={updateField} />
                <Field draft={draft} field="aliases" label="别名" onChange={updateField} />
                <Field draft={draft} field="identities" label="身份" onChange={updateField} />
                <Field draft={draft} field="biography" label="歌手简介" onChange={updateField} multiline />
              </>
            )}
          </div>
        </div>

        {notice && <p className="metadata-dialog-notice" role="status">{notice}</p>}

        <div className="metadata-dialog-footer">
          <button type="button" onClick={onSearch}>查找信息</button>
          <div className="playlist-dialog-actions">
            <button type="submit" className="primary" disabled={fields.length === 0 || status !== "idle"}>
              {status === "saving" ? <LoaderCircle className="metadata-spinner" size={14} /> : null}
              确定
            </button>
            <button type="button" onClick={onCancel}>取消</button>
          </div>
        </div>
      </form>
    </div>
  );
}
