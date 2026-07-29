import { useEffect } from "react";
import { LoaderCircle } from "lucide-react";
import type {
  PodcastDownloadCleanupIntent,
  PodcastQueueRemovalIntent,
} from "../types";
import { formatFileSize } from "../format";

function PodcastQueueRemovalDialog({
  intent,
  busy,
  onCancel,
  onConfirm,
}: {
  intent: PodcastQueueRemovalIntent;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel]);

  return (
    <div
      className="playlist-dialog-overlay podcast-queue-dialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className="playlist-dialog playlist-dialog-delete podcast-queue-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="podcast-queue-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="playlist-dialog-kicker">待播管理</span>
        <h2 id="podcast-queue-dialog-title">
          移除 {intent.episodeIds.length} 集待播
        </h2>
        <p className="playlist-dialog-message">
          只会从当前待播队列移除，下载文件与收听进度都会保留。
        </p>
        <div className="playlist-dialog-actions">
          <button
            type="submit"
            className="danger"
            disabled={busy}
          >
            {busy ? (
              <>
                <LoaderCircle className="podcast-spinner" size={15} />
                正在移除
              </>
            ) : "移除"}
          </button>
          <button type="button" onClick={onCancel} disabled={busy} autoFocus>
            取消
          </button>
        </div>
      </form>
    </div>
  );
}

function PodcastDownloadCleanupDialog({
  intent,
  busy,
  onCancel,
  onConfirm,
}: {
  intent: PodcastDownloadCleanupIntent;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel]);

  const title = intent.kind === "selected"
    ? `删除 ${intent.episodeIds.length} 集下载`
    : "清理已听完下载";

  return (
    <div
      className="playlist-dialog-overlay podcast-download-dialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className="playlist-dialog playlist-dialog-delete podcast-download-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="podcast-download-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="playlist-dialog-kicker">下载管理</span>
        <h2 id="podcast-download-dialog-title">{title}</h2>
        <p className="playlist-dialog-message">
          {intent.kind === "selected"
            ? `将释放约 ${formatFileSize(
              intent.downloadedBytes,
            )}。单集和收听进度仍会保留。`
            : "将删除所有已听完单集的离线文件。单集和收听进度仍会保留。"}
        </p>
        <div className="playlist-dialog-actions">
          <button
            type="submit"
            className="danger"
            disabled={busy}
          >
            {busy ? (
              <>
                <LoaderCircle className="podcast-spinner" size={15} />
                正在删除
              </>
            ) : "删除"}
          </button>
          <button type="button" onClick={onCancel} disabled={busy} autoFocus>
            取消
          </button>
        </div>
      </form>
    </div>
  );
}

export { PodcastDownloadCleanupDialog, PodcastQueueRemovalDialog };
