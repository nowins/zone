import { Folder, FolderPlus, Music2, RefreshCw, Trash2 } from "lucide-react";
import type { MusicFolder } from "../types";

export function SettingsView({
  folders,
  trackCount,
  isScanning,
  onAddFolder,
  onRescan,
  onClear,
}: {
  folders: MusicFolder[];
  trackCount: number;
  isScanning: boolean;
  onAddFolder: () => void;
  onRescan: () => void;
  onClear: () => void;
}) {
  const folderCount = folders.length;

  return (
    <section className="content-band settings-page">
      <header className="settings-header">
        <div>
          <span className="settings-overline">ZONE / 资料库</span>
          <h1>设置</h1>
          <p>管理音乐来源、扫描状态和本地资料库。</p>
        </div>
      </header>

      <div className="settings-layout">
        <section className="settings-library" aria-labelledby="music-folders-heading">
          <header className="settings-section-heading">
            <div>
              <span className="settings-kicker">音乐</span>
              <h2 id="music-folders-heading">音乐文件夹</h2>
              <p>Zone 会读取这些位置中的音乐，并在重新扫描后更新收藏。</p>
            </div>
            <button className="settings-add-folder" onClick={onAddFolder} disabled={isScanning}>
              <FolderPlus size={18} aria-hidden="true" />
              <span>添加文件夹</span>
            </button>
          </header>

          <div className="folder-list" aria-live="polite">
            {folderCount === 0 ? (
              <div className="folder-empty">
                <Music2 size={24} aria-hidden="true" />
                <div>
                  <strong>尚未添加音乐文件夹</strong>
                  <span>添加一个常用音乐目录后，Zone 会立即建立本地索引。</span>
                </div>
              </div>
            ) : (
              folders.map((folder) => (
                <div className="folder-row" key={folder.path}>
                  <Folder className="folder-row-icon" size={20} aria-hidden="true" />
                  <div className="folder-row-copy">
                    <strong>{folder.name}</strong>
                    <span title={folder.path}>{folder.path}</span>
                  </div>
                  <span className="folder-row-state">已包含</span>
                </div>
              ))
            )}
          </div>
        </section>

        <aside className="settings-sidebar" aria-label="资料库状态与维护">
          <section className="settings-overview">
            <span className="settings-kicker">资料库</span>
            <h2>当前状态</h2>
            <dl>
              <div>
                <dt>歌曲</dt>
                <dd>{trackCount}</dd>
              </div>
              <div>
                <dt>文件夹</dt>
                <dd>{folderCount}</dd>
              </div>
            </dl>
            <p className={isScanning ? "scan-state scanning" : "scan-state"}>
              {isScanning ? "正在读取音乐和封面…" : folderCount > 0 ? "资料库已准备就绪" : "等待添加音乐来源"}
            </p>
            <button
              className="settings-secondary-action"
              onClick={onRescan}
              disabled={folderCount === 0 || isScanning}
            >
              <RefreshCw size={16} aria-hidden="true" />
              <span>{isScanning ? "正在扫描" : "重新扫描资料库"}</span>
            </button>
          </section>

          <section className="settings-danger-zone">
            <span className="settings-kicker">维护</span>
            <h2>清理资料库</h2>
            <p>移除 Zone 保存的索引、队列和播放状态，不会删除电脑中的音乐文件。</p>
            <button className="settings-danger-action" onClick={onClear} disabled={folderCount === 0 && trackCount === 0}>
              <Trash2 size={16} aria-hidden="true" />
              <span>清空资料库</span>
            </button>
          </section>
        </aside>
      </div>
    </section>
  );
}
