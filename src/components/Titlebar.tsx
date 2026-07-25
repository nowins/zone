import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minimize2, X } from "lucide-react";

export function Titlebar() {
  const appWindow = getCurrentWindow();

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div data-tauri-drag-region />
      <div className="window-controls">
        <button onClick={() => appWindow.minimize()} title="Minimize">
          <Minimize2 size={14} />
        </button>
        <button onClick={() => appWindow.toggleMaximize()} title="Maximize">
          <Maximize2 size={14} />
        </button>
        <button onClick={() => appWindow.close()} title="Close">
          <X size={15} />
        </button>
      </div>
    </header>
  );
}
