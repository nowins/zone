import type { CSSProperties } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { initials } from "../utils/music";

export function Cover({
  artPath,
  label,
  size,
  index = 0,
}: {
  artPath?: string | null;
  label: string;
  size: "mini" | "large" | "hero";
  index?: number;
}) {
  const className = size === "mini" ? "mini-cover" : size === "hero" ? "hero-cover cover" : "cover";
  const imageSrc = artPath ? convertFileSrc(artPath) : null;

  return (
    <div className={className} style={{ "--accent-index": index % 6 } as CSSProperties}>
      {imageSrc ? <img src={imageSrc} alt="" draggable={false} /> : <span>{initials(label)}</span>}
    </div>
  );
}
