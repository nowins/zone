import type { KeyboardEvent, ReactNode } from "react";
import { Tile } from "./Tile";
import type { TileSize } from "./Tile";

/**
 * WP8 iconic tile: a clean accent surface with a centered icon, an optional
 * corner count/badge, and a bottom label strip. Content updates are reflected
 * in the props; the tile itself does not animate continuously.
 */
export function IconicTile({
  size = "medium",
  className = "",
  icon,
  label,
  count,
  onPress,
  onContextMenu,
  onKeyDown,
  title,
  disabled = false,
}: {
  size?: TileSize;
  className?: string;
  icon: ReactNode;
  label?: ReactNode;
  count?: number | null;
  onPress?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <Tile
      size={size}
      className={`tile-iconic ${className}`.trim()}
      onPress={onPress}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      title={title}
      disabled={disabled}
    >
      <div className="tile-iconic-icon">{icon}</div>
      {typeof count === "number" && count > 0 ? (
        <span className="tile-iconic-count" aria-label={`${count} 项`}>
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
      {label ? <div className="tile-iconic-label">{label}</div> : null}
    </Tile>
  );
}
