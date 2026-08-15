import { FolderPlus } from "lucide-react";
import { Button } from "./Button";

export function EmptyState({ onAddFolder, isScanning }: { onAddFolder: () => void; isScanning: boolean }) {
  return (
    <div className="empty-state">
      <div className="empty-mark">音乐</div>
      <Button variant="solid" size="xl" onClick={onAddFolder} busy={isScanning} icon={<FolderPlus size={22} />}>
        <span>{isScanning ? "正在扫描" : "添加音乐文件夹"}</span>
      </Button>
    </div>
  );
}
