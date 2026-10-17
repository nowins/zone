import { useLayoutEffect } from "react";
import type { AppPage } from "../types";

/** Keep body portals on the same palette as the active application surface. */
export function useSurfaceTheme(ready: boolean, compact: boolean, page: AppPage) {
  const theme = ready && !compact && page !== "nowPlaying" ? "light" : "dark";
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute("data-surface-theme");
    root.dataset.surfaceTheme = theme;
    return () => {
      if (previous === null) root.removeAttribute("data-surface-theme");
      else root.setAttribute("data-surface-theme", previous);
    };
  }, [theme]);
  return theme;
}
