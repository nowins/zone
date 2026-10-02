import { ChevronDown, ChevronUp, FileJson2, Folder, FolderPlus, Globe2, Music2, RefreshCw, Trash2 } from "lucide-react";
import type { MetadataProviderDescriptor, MusicFolder } from "../types";
import { useLyricsProviderSettings } from "../hooks/useLyricsProviderSettings";
import { Button } from "../components/Button";
import type { QueueInsertMode } from "../app/playbackSettings";
import { musicAnalyzeFeatures, musicFeatureStatus, type FeatureJobStatus } from "../app/musicLibraryApi";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { exportDiagnostics } from "../utils/diagnostics";
import { Dialog } from "../components/Dialog";
import { Presence } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";
import { createPortal } from "react-dom";
import { APP_VERSION, RELEASE_LINKS } from "../app/releaseInfo";
import { PRIVACY_LINKS, PRIVACY_SECTIONS } from "../app/privacy";

export function SettingsView({
  folders,
  trackCount,
  isScanning,
  onCancelScan,
  scanNote,
  metadataProviders,
  onToggleMetadataProvider,
  queueInsertMode,
  adaptivePrevious,
  closeToTray,
  onQueueInsertModeChange,
  onAdaptivePreviousChange,
  onCloseToTrayChange,
  onAddFolder,
  onRescan,
  onClear,
}: {
  folders: MusicFolder[];
  trackCount: number;
  isScanning: boolean;
  onCancelScan: () => void;
  scanNote: string;
  metadataProviders: MetadataProviderDescriptor[];
  onToggleMetadataProvider: (providerId: string, enabled: boolean) => void;
  queueInsertMode: QueueInsertMode;
  adaptivePrevious: boolean;
  closeToTray: boolean;
  onQueueInsertModeChange: (mode: QueueInsertMode) => void;
  onAdaptivePreviousChange: (enabled: boolean) => void;
  onCloseToTrayChange: (enabled: boolean) => void;
  onAddFolder: () => void;
  onRescan: () => void;
  onClear: () => Promise<void>;
}) {
  const folderCount = folders.length;
  const { configs, providers, setEnabled, move } = useLyricsProviderSettings();
  const [diagnosticNotice, setDiagnosticNotice] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState("");
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [privacyNotice, setPrivacyNotice] = useState("");
  async function clearLibrary() {
    if (clearBusy || isScanning) return;
    setClearBusy(true);
    setClearError("");
    try {
      await onClear();
      setConfirmClear(false);
    } catch {
      setClearError("清空失败，已有资料已保留，请重试");
    } finally { setClearBusy(false); }
  }
  async function saveDiagnostics() {
    try {
      const saved = await invoke<boolean>("export_diagnostics", { content: exportDiagnostics() });
      setDiagnosticNotice(saved ? "诊断记录已导出" : "");
    } catch { setDiagnosticNotice("导出失败，请重试"); }
  }
  const [featureStatus, setFeatureStatus] = useState<FeatureJobStatus | null>(null);
  const [featureBusy, setFeatureBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void musicFeatureStatus()
      .then((status) => {
        if (!cancelled) setFeatureStatus(status);
      })
      .catch(() => undefined);
    let unlisten: (() => void) | undefined;
    void listen<FeatureJobStatus>("feature-status-changed", ({ payload }) => {
      if (!cancelled) setFeatureStatus(payload);
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
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
              <Button variant="page" size="lg" className="settings-heading-action" onClick={onAddFolder} disabled={isScanning} icon={<FolderPlus size={18} aria-hidden="true" />}>
                <span>添加文件夹</span>
              </Button>
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


          <section className="settings-playback" aria-labelledby="playback-behavior-heading">
            <header className="settings-section-heading">
              <div>
                <span className="settings-kicker">播放</span>
                <h2 id="playback-behavior-heading">播放行为</h2>
                <p>调整加入队列的默认位置，以及“上一首”在进度靠后时是否重播当前曲目。</p>
              </div>
            </header>

            <div className="settings-behavior-list">
              <div className="settings-behavior-row">
                <div>
                  <strong>加入队列</strong>
                  <span>默认把歌曲放到“下一首”或“队列末尾”。右键菜单仍可临时选择另一种方式。</span>
                </div>
                <div className="settings-segmented" role="group" aria-label="加入队列方式">
                  <button
                    type="button"
                    className={queueInsertMode === "play_next" ? "is-active" : undefined}
                    aria-pressed={queueInsertMode === "play_next"}
                    onClick={() => onQueueInsertModeChange("play_next")}
                  >
                    下一首
                  </button>
                  <button
                    type="button"
                    className={queueInsertMode === "append_end" ? "is-active" : undefined}
                    aria-pressed={queueInsertMode === "append_end"}
                    onClick={() => onQueueInsertModeChange("append_end")}
                  >
                    队列末尾
                  </button>
                </div>
              </div>

              <div className="settings-behavior-row">
                <div>
                  <strong>智能上一首</strong>
                  <span>播放超过约 3 秒后再按上一首，会回到当前歌曲开头。</span>
                </div>
                <button
                  className="provider-toggle"
                  type="button"
                  role="switch"
                  aria-checked={adaptivePrevious}
                  onClick={() => onAdaptivePreviousChange(!adaptivePrevious)}
                >
                  <span aria-hidden="true" />
                  {adaptivePrevious ? "已启用" : "已关闭"}
                </button>
              </div>

              <div className="settings-behavior-row">
                <div>
                  <strong>关闭到托盘</strong>
                  <span>点击窗口关闭时隐藏到托盘，而不是退出应用。</span>
                </div>
                <button
                  className="provider-toggle"
                  type="button"
                  role="switch"
                  aria-checked={closeToTray}
                  onClick={() => onCloseToTrayChange(!closeToTray)}
                >
                  <span aria-hidden="true" />
                  {closeToTray ? "已启用" : "已关闭"}
                </button>
              </div>
            </div>
          </section>


          <section className="settings-smartdj" aria-labelledby="smartdj-features-heading">
            <header className="settings-section-heading">
              <div>
                <span className="settings-kicker">SmartDJ</span>
                <h2 id="smartdj-features-heading">听感分析</h2>
                <p>后台会为曲库建立特征，用于更接近“听感相似”的电台推荐。</p>
              </div>
              <Button
                variant="page"
                size="lg"
                className="settings-heading-action"
                busy={featureBusy}
                onClick={() => {
                  setFeatureBusy(true);
                  void musicAnalyzeFeatures(120)
                    .then((status) => setFeatureStatus(status))
                    .finally(() => setFeatureBusy(false));
                }}
              >
                <span>{featureBusy ? "已加入分析队列" : "立即分析"}</span>
              </Button>
            </header>
            <div className="settings-behavior-list">
              <div className="settings-behavior-row">
                <div>
                  <strong>特征覆盖</strong>
                  <span>
                    {featureStatus
                      ? featureStatus.pending + featureStatus.running > 0
                        ? `分析中 ${featureStatus.done} / 共 ${featureStatus.totalTracks} 首`
                        : `已完成 ${featureStatus.done} / 共 ${featureStatus.totalTracks} 首${featureStatus.failed > 0 ? `，失败 ${featureStatus.failed}` : ""}`
                      : "正在读取分析状态…"}
                  </span>
                </div>
              </div>
            </div>
          </section>

          <section className="settings-metadata-providers" aria-labelledby="metadata-providers-heading">
            <header className="settings-section-heading">
              <div>
                <span className="settings-kicker">音乐信息</span>
                <h2 id="metadata-providers-heading">补充来源</h2>
                <p>补充内容保存在本地数据库中，不会改写音乐文件。在线查找会向对应来源发送曲名、歌手、专辑和时长。</p>
              </div>
            </header>
            <div className="metadata-provider-list">
              {metadataProviders.map((provider) => (
                <div
                  className={provider.enabled ? "metadata-provider-row is-enabled" : "metadata-provider-row"}
                  key={provider.id}
                >
                  <FileJson2 size={20} aria-hidden="true" />
                  <div>
                    <strong>{provider.name}</strong>
                    <span>{provider.description}</span>
                    <em>{provider.experimental ? "实验性来源" : "内置来源"}</em>
                  </div>
                  <button
                    className="provider-toggle"
                    type="button"
                    role="switch"
                    aria-checked={provider.enabled}
                    disabled={!provider.available}
                    onClick={() => onToggleMetadataProvider(provider.id, !provider.enabled)}
                  >
                    <span aria-hidden="true" />
                    {!provider.available ? "暂不可用" : provider.enabled ? "已启用" : "已关闭"}
                  </button>
                </div>
              ))}
              {metadataProviders.length === 0 && (
                <p className="metadata-provider-empty">正在读取补充来源…</p>
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
              {scanNote || (isScanning ? "正在读取音乐和封面…" : folderCount > 0 ? "资料库已准备就绪" : "等待添加音乐来源")}
            </p>
            <Button
              variant="ghost"
              className="settings-secondary-action"
              onClick={onRescan}
              busy={isScanning}
              disabled={folderCount === 0 || isScanning}
              icon={<RefreshCw size={16} aria-hidden="true" />}
            >
              <span>{isScanning ? "正在扫描" : "重新扫描资料库"}</span>
            </Button>
            {isScanning && <Button variant="ghost" onClick={onCancelScan}>取消扫描</Button>}
          </section>

          <section className="settings-diagnostics">
            <Button variant="ghost" onClick={() => void saveDiagnostics()} icon={<FileJson2 size={16} />}>导出诊断记录</Button>
            {diagnosticNotice && <p role="status">{diagnosticNotice}</p>}
          </section>
          <section className="settings-about" aria-label="关于 Zone">
            <span className="settings-kicker">关于</span><h2>Zone {APP_VERSION}</h2>
            <Button variant="ghost" onClick={() => { setPrivacyNotice(""); setShowPrivacy(true); }}>隐私说明</Button>
            {RELEASE_LINKS.support && <Button variant="ghost" onClick={() => void invoke("plugin:opener|open_url", { url: RELEASE_LINKS.support }).catch(() => setDiagnosticNotice("无法打开帮助页面，请重试"))}>反馈与帮助</Button>}
            {RELEASE_LINKS.download && <Button variant="ghost" onClick={() => void invoke("plugin:opener|open_url", { url: RELEASE_LINKS.download }).catch(() => setDiagnosticNotice("无法打开下载页面，请重试"))}>获取新版</Button>}
          </section>
          <section className="settings-danger-zone">
            <span className="settings-kicker">维护</span>
            <h2>清理资料库</h2>
            <p>移除音乐索引、歌单、喜欢、固定内容和播放统计，保留播客资料。不会删除电脑中的音乐文件。</p>
            <Button variant="danger" className="settings-danger-action" onClick={() => { setClearError(""); setConfirmClear(true); }} disabled={isScanning || clearBusy || (folderCount === 0 && trackCount === 0)} icon={<Trash2 size={16} aria-hidden="true" />}>
              <span>清空资料库</span>
            </Button>
          </section>
        </aside>
      </div>
      {createPortal(<Presence show={confirmClear} exitDurationMs={MOTION_DURATIONS.micro}>
        <Dialog titleId="clear-library-title" kicker="音乐资料库" title="清空音乐资料库？"
          busy={clearBusy} onCancel={() => setConfirmClear(false)} onSubmit={event => { event.preventDefault(); void clearLibrary(); }}
          actions={<><Button variant="ghost" disabled={clearBusy} onClick={() => setConfirmClear(false)}>取消</Button><Button variant="danger" type="submit" busy={clearBusy} disabled={isScanning}>确认清空</Button></>}>
          <p>音乐文件与播客资料会保留。音乐歌单、喜欢、固定内容和播放统计将被清除。</p>
          {clearError && <p role="alert">{clearError}</p>}
        </Dialog>
      </Presence>, document.body)}
      {createPortal(<Presence show={showPrivacy} exitDurationMs={MOTION_DURATIONS.micro}>
        <Dialog titleId="privacy-title" kicker="Zone" title="隐私说明" className="settings-info-dialog"
          onCancel={() => setShowPrivacy(false)} onSubmit={event => event.preventDefault()}
          actions={<Button variant="ghost" onClick={() => setShowPrivacy(false)}>关闭</Button>}>
          <div className="settings-info-copy" tabIndex={0}>
            {PRIVACY_SECTIONS.map(section => <section key={section.title}><h3>{section.title}</h3><p>{section.text}</p></section>)}
            <div className="settings-privacy-links">
              {PRIVACY_LINKS.map(link => <Button key={link.url} variant="ghost" onClick={() => void invoke("plugin:opener|open_url", { url: link.url }).catch(() => setPrivacyNotice("无法打开隐私页面，请重试"))}>{link.label}</Button>)}
            </div>
            {privacyNotice && <p role="alert">{privacyNotice}</p>}
          </div>
        </Dialog>
      </Presence>, document.body)}
    </section>
  );
}
