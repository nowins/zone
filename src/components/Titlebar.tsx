import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";

export function Titlebar() {
  const appWindow = getCurrentWindow();

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div data-tauri-drag-region />
      <div className="window-controls">
        <button onClick={() => appWindow.minimize()} title="最小化">
          <Minus size={15} />
        </button>
        <button onClick={() => appWindow.toggleMaximize()} title="最大化">
          <Square size={12} />
        </button>
        <button onClick={() => appWindow.close()} title="关闭">
          <X size={15} />
        </button>
      </div>
    </header>
  );
}
