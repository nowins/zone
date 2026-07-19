import { FolderPlus } from "lucide-react";

export function EmptyState({ onAddFolder, isScanning }: { onAddFolder: () => void; isScanning: boolean }) {
  return (
    <div className="empty-state">
      <div className="empty-mark">音乐</div>
      <button className="primary-action" onClick={onAddFolder} disabled={isScanning}>
        <FolderPlus size={22} />
        <span>{isScanning ? "正在扫描" : "添加音乐文件夹"}</span>
      </button>
    </div>
  );
}
