import { FolderPlus, Search, X } from "lucide-react";
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
  return (
    <section className="content-band settings-page">
      <div className="collection-header">
        <div>
          <h1>settings</h1>
          <p>{trackCount} songs indexed</p>
        </div>
      </div>

      <div className="settings-grid">
        <section>
          <h2>music folders</h2>
          <div className="folder-list">
            {folders.length === 0 ? (
              <p className="quiet">no folders added</p>
            ) : (
              folders.map((folder) => (
                <div key={folder.path}>
                  <strong>{folder.name}</strong>
                  <span>{folder.path}</span>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="settings-actions">
          <button className="primary-action" onClick={onAddFolder}>
            <FolderPlus size={22} />
            <span>add folder</span>
          </button>
          <button className="primary-action" onClick={onRescan} disabled={folders.length === 0 || isScanning}>
            <Search size={22} />
            <span>{isScanning ? "scanning" : "rescan library"}</span>
          </button>
          <button className="primary-action danger" onClick={onClear} disabled={folders.length === 0 && trackCount === 0}>
            <X size={22} />
            <span>clear library</span>
          </button>
        </section>
      </div>
    </section>
  );
}
