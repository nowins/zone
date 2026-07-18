import { useEffect, useState } from "react";
import { ListMusic, Sparkles } from "lucide-react";

export type PlaylistDialogState = {
  mode: "create" | "rename" | "delete";
  playlistId?: string;
  playlistName?: string;
};

export function PlaylistDialog({
  dialog,
  onCancel,
  onSubmit,
  onCreateSmart,
}: {
  dialog: PlaylistDialogState;
  onCancel: () => void;
  onSubmit: (name: string) => void;
  onCreateSmart?: () => void;
}) {
  const [draftName, setDraftName] = useState(dialog.playlistName ?? "");
  const [createKind, setCreateKind] = useState<"manual" | null>(dialog.mode === "create" ? null : "manual");
  const isDelete = dialog.mode === "delete";
  const title = dialog.mode === "create"
    ? "新建播放列表"
    : dialog.mode === "rename"
      ? "重命名播放列表"
      : "删除播放列表";

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isDelete) {
      onSubmit("");
      return;
    }

    if (dialog.mode === "create" && !createKind) return;
    const cleanName = draftName.trim();
    if (cleanName) onSubmit(cleanName);
  }

  return (
    <div
      className="playlist-dialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className={`playlist-dialog playlist-dialog-${dialog.mode}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="playlist-dialog-title"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="playlist-dialog-kicker">播放列表</span>
        <h2 id="playlist-dialog-title">{title}</h2>

        {dialog.mode === "create" && !createKind ? (
          <div className="playlist-kind-options">
            <button type="button" onClick={() => setCreateKind("manual")}>
              <ListMusic size={22} />
              <span><strong>普通播放列表</strong><small>手动添加并排列歌曲</small></span>
            </button>
            <button type="button" onClick={onCreateSmart}>
              <Sparkles size={22} />
              <span><strong>智能播放列表</strong><small>按规则与收听习惯自动更新</small></span>
            </button>
          </div>
        ) : isDelete ? (
          <p className="playlist-dialog-message">
            确定删除“{dialog.playlistName}”吗？其中的歌曲不会从音乐库中删除。
          </p>
        ) : (
          <label>
            <span>名称</span>
            <input
              autoFocus
              maxLength={80}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="输入播放列表名称"
              aria-describedby="playlist-dialog-hint"
            />
            <small id="playlist-dialog-hint">
              {dialog.mode === "create" ? "创建后会自动打开新的播放列表" : "只修改名称，不会改变其中的歌曲"}
            </small>
          </label>
        )}

        <div className="playlist-dialog-actions">
          {dialog.mode === "create" && createKind && (
            <button type="button" onClick={() => { setCreateKind(null); setDraftName(""); }}>返回</button>
          )}
          {(dialog.mode !== "create" || createKind) && (
          <button
            type="submit"
            className={isDelete ? "danger" : "primary"}
            disabled={!isDelete && !draftName.trim()}
          >
            {isDelete ? "删除" : "确定"}
          </button>
          )}
          <button type="button" onClick={onCancel}>取消</button>
        </div>
      </form>
    </div>
  );
}
