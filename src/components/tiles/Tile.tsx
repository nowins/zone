import type { CSSProperties, ReactNode } from "react";
import { tiltPressClear, tiltPressDown } from "../../utils/tiltPress";
import type { KeyboardEvent, PointerEvent } from "react";

export type TileSize = "small" | "medium" | "wide" | "large";

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
    if (disabled) return;
    tiltPressDown(event, tiltSelector);
  }
  function handlePointerClear(event: PointerEvent<HTMLElement>) {
    tiltPressClear(event, tiltSelector);
  }
  function handleClick() {
    // aria-disabled keeps the tile focusable (edit-mode keyboard reorder), so
    // the primitive itself must swallow activation while disabled.
    if (disabled) return;
    onPress?.();
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
      aria-label={title}
      aria-disabled={disabled || undefined}
      onClick={handleClick}
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
