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
