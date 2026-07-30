import { useEffect, useMemo, useState } from "react";
import { DEFAULT_PLAYLIST_ID } from "../constants";
import type { ContextPayload, ManualPlaylist, Playlist } from "../types";

export function AddToPlaylistDialog({
  payload,
  playlists,
  onCancel,
  onChoose,
  onCreate,
}: {
  payload: ContextPayload;
  playlists: Playlist[];
  onCancel: () => void;
  onChoose: (playlistId: string) => void;
  onCreate: (name: string) => void;
}) {
  const options = useMemo(() => playlists.filter((playlist): playlist is ManualPlaylist => (
    playlist.kind !== "smart"
      && playlist.id !== DEFAULT_PLAYLIST_ID
      && playlist.id !== payload.playlistId
  )), [payload.playlistId, playlists]);
  const [selectedId, setSelectedId] = useState<string | null>(options[0]?.id ?? null);
  const [creating, setCreating] = useState(options.length === 0);
  const [draftName, setDraftName] = useState("");

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (creating) {
      const cleanName = draftName.trim();
      if (cleanName) onCreate(cleanName);
      return;
    }
    if (selectedId) onChoose(selectedId);
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
        className="playlist-dialog playlist-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="playlist-picker-title"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="playlist-dialog-kicker">音乐</span>
        <h2 id="playlist-picker-title">
          {creating ? "新建播放列表" : "选择一个播放列表"}
        </h2>

        {creating ? (
          <label className="playlist-picker-name">
            <span>名称</span>
            <input
              autoFocus
              maxLength={80}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="输入播放列表名称"
            />
          </label>
        ) : (
          <div className="playlist-picker-list" role="listbox" aria-label="播放列表">
            {options.map((playlist) => (
              <button
                key={playlist.id}
                className={selectedId === playlist.id ? "selected" : ""}
                type="button"
                role="option"
                aria-selected={selectedId === playlist.id}
                onClick={() => setSelectedId(playlist.id)}
                onDoubleClick={() => onChoose(playlist.id)}
              >
                <strong>{playlist.name}</strong>
                <span>{playlist.trackIds.length} 首歌曲</span>
              </button>
            ))}
          </div>
        )}

        <div className="playlist-dialog-actions playlist-picker-actions">
          {creating && options.length > 0 && (
            <button type="button" onClick={() => { setCreating(false); setDraftName(""); }}>
              返回
            </button>
          )}
          <button
            className="primary"
            type="submit"
            disabled={creating ? !draftName.trim() : !selectedId}
          >
            {creating ? "创建并添加" : "确定"}
          </button>
          <button type="button" onClick={onCancel}>取消</button>
          {!creating && (
            <button type="button" onClick={() => setCreating(true)}>新建播放列表</button>
          )}
        </div>
      </form>
    </div>
  );
}
