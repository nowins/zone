import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Settings2, Square, X } from "lucide-react";

export function Titlebar({
  isSettings,
  onOpenSettings,
  closeToTray = true,
}: {
  isSettings: boolean;
  onOpenSettings: () => void;
  closeToTray?: boolean;
}) {
  const appWindow = getCurrentWindow();

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div data-tauri-drag-region />
      <div className="window-controls">
        <button
          className={isSettings ? "titlebar-settings active" : "titlebar-settings"}
          onClick={onOpenSettings}
          title="设置"
          aria-current={isSettings ? "page" : undefined}
        >
          <Settings2 size={13} aria-hidden="true" />
          <span>设置</span>
        </button>
        <button onClick={() => appWindow.minimize()} title="最小化">
          <Minus size={15} />
        </button>
        <button onClick={() => appWindow.toggleMaximize()} title="最大化">
          <Square size={12} />
        </button>
        <button
          onClick={() => {
            if (closeToTray) void appWindow.hide();
            else void appWindow.close();
          }}
          title={closeToTray ? "关闭到托盘" : "关闭"}
        >
          <X size={15} />
        </button>
      </div>
    </header>
  );
}
