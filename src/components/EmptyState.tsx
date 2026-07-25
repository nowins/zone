import { FolderPlus } from "lucide-react";

export function EmptyState({ onAddFolder, isScanning }: { onAddFolder: () => void; isScanning: boolean }) {
  return (
    <div className="empty-state">
      <div className="empty-mark">music</div>
      <button className="primary-action" onClick={onAddFolder} disabled={isScanning}>
        <FolderPlus size={22} />
        <span>{isScanning ? "scanning" : "add music folder"}</span>
      </button>
    </div>
  );
}
