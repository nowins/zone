import { isValidElement, type ReactNode } from "react";

export type TileFrame = { id: string; content: ReactNode };

/** Keep media identity independent of its position in a refreshed pool. */
export function tileFrames(nodes: ReactNode[], limit: number): TileFrame[] {
  return nodes.slice(0, limit).map((content, index) => {
    if (!isValidElement(content)) return { id: `${typeof content}:${String(content)}`, content };
    const props = content.props as { artPath?: string; src?: string };
    return { id: String(content.key ?? props.artPath ?? props.src ?? index), content };
  });
}

export function frameReady(element: HTMLElement | null | undefined) {
  if (!element || element.querySelector('[data-cover-ready="false"]')) return false;
  return [...element.querySelectorAll("img")].every(image => image.complete && image.naturalWidth > 0);
}
