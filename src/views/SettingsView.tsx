import { ChevronDown, ChevronUp, Folder, FolderPlus, Globe2, Music2, RefreshCw, Trash2 } from "lucide-react";
import type { MusicFolder } from "../types";
import { useLyricsProviderSettings } from "../hooks/useLyricsProviderSettings";

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
  const { configs, providers, setEnabled, move } = useLyricsProviderSettings();
  const configById = new Map(configs.map((config) => [config.id, config]));
  const orderedProviders = [...providers].sort((left, right) => (
    (configById.get(left.id)?.priority ?? left.defaultPriority)
      - (configById.get(right.id)?.priority ?? right.defaultPriority)
  ));

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
        <div className="settings-main-stack">
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

          <section className="settings-lyrics-providers" aria-labelledby="lyrics-providers-heading">
            <header className="settings-section-heading">
              <div>
                <span className="settings-kicker">歌词</span>
                <h2 id="lyrics-providers-heading">在线来源</h2>
                <p>本地歌词缺失时，Zone 会按以下顺序搜索。启用后会向对应来源发送曲名、歌手和专辑。</p>
              </div>
            </header>
            <div className="provider-list">
              {orderedProviders.map((provider, index) => {
                const config = configById.get(provider.id);
                const enabled = config?.enabled ?? provider.defaultEnabled;
                return (
                  <div className={enabled ? "provider-row is-enabled" : "provider-row"} key={provider.id}>
                    <Globe2 size={20} aria-hidden="true" />
                    <div className="provider-row-copy">
                      <strong>{provider.name}</strong>
                      <span>{provider.description}</span>
                      <em>{provider.capabilities.includes("word") ? "逐词" : "逐行"} · 无需账户</em>
                    </div>
                    <div className="provider-priority" aria-label={`${provider.name} 优先级`}>
                      <button
                        type="button"
                        title="提高优先级"
                        aria-label={`提高 ${provider.name} 优先级`}
                        disabled={index === 0}
                        onClick={() => move(provider.id, -1)}
                      >
                        <ChevronUp size={15} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        title="降低优先级"
                        aria-label={`降低 ${provider.name} 优先级`}
                        disabled={index === orderedProviders.length - 1}
                        onClick={() => move(provider.id, 1)}
                      >
                        <ChevronDown size={15} aria-hidden="true" />
                      </button>
                    </div>
                    <button
                      className="provider-toggle"
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      onClick={() => setEnabled(provider.id, !enabled)}
                    >
                      <span aria-hidden="true" />
                      {enabled ? "已启用" : "已关闭"}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

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
