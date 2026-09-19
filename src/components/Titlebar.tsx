import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minus, Pin, Settings2, Smartphone, Square, X } from "lucide-react";

export function Titlebar({
  isSettings,
  onOpenSettings,
  closeToTray = true,
  showSettings = true,
  compact = false,
  modePending = false,
  onToggleCompact,
  pinned = false,
  onTogglePinned,
}: {
  isSettings: boolean;
  onOpenSettings: () => void;
  closeToTray?: boolean;
  showSettings?: boolean;
  compact?: boolean;
  modePending?: boolean;
  onToggleCompact?: () => void;
  pinned?: boolean;
  onTogglePinned?: () => void;
}) {
  const appWindow = getCurrentWindow();

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div data-tauri-drag-region>{compact ? <span className="compact-wordmark" data-tauri-drag-region>zone</span> : null}</div>
      <div className="window-controls">
        {showSettings ? <button
          className={isSettings ? "titlebar-settings active" : "titlebar-settings"}
          onClick={onOpenSettings}
          title="设置"
          aria-current={isSettings ? "page" : undefined}
        >
          <Settings2 size={13} aria-hidden="true" />
          <span>设置</span>
        </button> : null}
        {compact && onTogglePinned ? <button
          className="titlebar-pin"
          onClick={onTogglePinned}
          disabled={modePending}
          title={pinned ? "取消置顶" : "置顶窗口"}
          aria-label="置顶窗口"
          aria-pressed={pinned}
        >
          <Pin size={13} fill={pinned ? "currentColor" : "none"} aria-hidden="true" />
        </button> : null}
        {onToggleCompact ? <button
          className="titlebar-mode"
          onClick={onToggleCompact}
          disabled={modePending}
          title={compact ? "返回正常模式" : "小屏模式"}
          aria-label={compact ? "返回正常模式" : "小屏模式"}
          aria-pressed={compact}
        >
          {compact ? <Maximize2 size={14} /> : <Smartphone size={14} />}
        </button> : null}
        <button onClick={() => appWindow.minimize()} title="最小化">
          <Minus size={15} />
        </button>
        {!compact ? <button onClick={() => appWindow.toggleMaximize()} title="最大化">
          <Square size={12} />
        </button> : null}
        <button
          onClick={() => {
            void (async () => {
              try {
                if (closeToTray) await appWindow.hide();
                else {
                  // Prefer destroy so a lingering closeRequested interceptor
                  // cannot soft-swallow the exit when tray mode is off.
                  try {
                    await appWindow.destroy();
                  } catch {
                    await appWindow.close();
                  }
                }
              } catch (error) {
                // hide may be denied if the capability is missing; always keep
                // a real exit path so the window control never becomes a no-op.
                if (import.meta.env.DEV) console.warn("[titlebar] close failed", error);
                try {
                  await appWindow.destroy();
                } catch {
                  try {
                    await appWindow.close();
                  } catch {
                    // ignore tertiary failure
                  }
                }
              }
            })();
          }}
          title={closeToTray ? "关闭到托盘" : "关闭"}
        >
          <X size={15} />
        </button>
      </div>
    </header>
  );
}
