import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
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
  return (
    <Dialog
      titleId="podcast-queue-dialog-title"
      kicker="待播管理"
      title={"移除 " + intent.episodeIds.length + " 集待播"}
      className="playlist-dialog-delete podcast-queue-dialog"
      overlayClassName="podcast-queue-dialog-overlay"
      busy={busy}
      onCancel={onCancel}
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm();
      }}
      actions={(
        <>
          <Button type="submit" variant="danger" busy={busy}>
            {busy ? "正在移除" : "移除"}
          </Button>
          <Button onClick={onCancel} disabled={busy} autoFocus>
            取消
          </Button>
        </>
      )}
    >
      <p className="playlist-dialog-message">
        只会从当前待播队列移除，下载文件与收听进度都会保留。
      </p>
    </Dialog>
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
  const title = intent.kind === "selected"
    ? "删除 " + intent.episodeIds.length + " 集下载"
    : "清理已听完下载";

  return (
    <Dialog
      titleId="podcast-download-dialog-title"
      kicker="下载管理"
      title={title}
      className="playlist-dialog-delete podcast-download-dialog"
      overlayClassName="podcast-download-dialog-overlay"
      busy={busy}
      onCancel={onCancel}
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm();
      }}
      actions={(
        <>
          <Button type="submit" variant="danger" busy={busy}>
            {busy ? "正在删除" : "删除"}
          </Button>
          <Button onClick={onCancel} disabled={busy} autoFocus>
            取消
          </Button>
        </>
      )}
    >
      <p className="playlist-dialog-message">
        {intent.kind === "selected"
          ? "将释放约 " + formatFileSize(intent.downloadedBytes) + "。单集和收听进度仍会保留。"
          : "将删除所有已听完单集的离线文件。单集和收听进度仍会保留。"}
      </p>
    </Dialog>
  );
}

export { PodcastDownloadCleanupDialog, PodcastQueueRemovalDialog };
