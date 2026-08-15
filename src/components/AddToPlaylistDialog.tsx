import { useMemo, useState } from "react";
import { DEFAULT_PLAYLIST_ID } from "../constants";
import type { ContextPayload, ManualPlaylist, Playlist } from "../types";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

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
    <Dialog
      titleId="playlist-picker-title"
      kicker="音乐"
      title={creating ? "新建播放列表" : "选择一个播放列表"}
      className="playlist-picker-dialog"
      onCancel={onCancel}
      onSubmit={submit}
      actionsClassName="playlist-picker-actions"
      actions={(
        <>
          {creating && options.length > 0 && (
            <Button onClick={() => { setCreating(false); setDraftName(""); }}>
              返回
            </Button>
          )}
          <Button
            variant="primary"
            type="submit"
            disabled={creating ? !draftName.trim() : !selectedId}
          >
            {creating ? "创建并添加" : "确定"}
          </Button>
          <Button onClick={onCancel}>取消</Button>
          {!creating && (
            <Button onClick={() => setCreating(true)}>新建播放列表</Button>
          )}
        </>
      )}
    >
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
    </Dialog>
  );
}
