import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";

export function Titlebar() {
  const appWindow = getCurrentWindow();

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div data-tauri-drag-region />
      <div className="window-controls">
        <button onClick={() => appWindow.minimize()} title="Minimize">
          <Minus size={15} />
        </button>
        <button onClick={() => appWindow.toggleMaximize()} title="Maximize">
          <Square size={12} />
        </button>
        <button onClick={() => appWindow.close()} title="Close">
          <X size={15} />
        </button>
      </div>
    </header>
  );
}
