import type { CSSProperties, ReactNode } from "react";
import { tiltPressClear, tiltPressDown } from "../../utils/tiltPress";
import type { KeyboardEvent, PointerEvent } from "react";

export type TileSize = "medium" | "wide";

/**
 * Base Metro tile: a fixed-size, hard-clipped surface that carries the shared
 * WP7-style tilt press interaction and reduced-motion convergence. Content
 * inside stays inside the tile bounds; nothing bleeds.
 */
export function Tile({
  size = "medium",
  className = "",
  children,
  onPress,
  onContextMenu,
  onKeyDown,
  title,
  asButton = true,
  tiltSelector,
  style,
  disabled = false,
}: {
  size?: TileSize;
  className?: string;
  children: ReactNode;
  onPress?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  title?: string;
  asButton?: boolean;
  tiltSelector?: string;
  style?: CSSProperties;
  disabled?: boolean;
}) {
  const classes = `tile tile-${size} ${className}`.trim();

  function handlePointerDown(event: PointerEvent<HTMLElement>) {
    tiltPressDown(event, tiltSelector);
  }
  function handlePointerClear(event: PointerEvent<HTMLElement>) {
    tiltPressClear(event, tiltSelector);
  }

  if (!asButton) {
    return (
      <div className={classes} style={style} onContextMenu={onContextMenu}>
        {children}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={classes}
      style={style}
      title={title}
      aria-disabled={disabled || undefined}
      onClick={onPress}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerClear}
      onPointerLeave={handlePointerClear}
      onPointerCancel={handlePointerClear}
    >
      {children}
    </button>
  );
}
