import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { initials } from "../utils/music";

/**
 * The one artwork renderer. artPath is a local file routed through
 * convertFileSrc; src is an already-resolved URL (e.g. proxied podcast
 * artwork). Default chrome is the music cover classes with the
 * accent-index gradient placeholder; pass className to bring a context's
 * own surface classes and fallback to replace the initials placeholder -
 * podcast artwork uses both.
 */
export function Cover({
  artPath,
  src,
  label,
  size = "large",
  index = 0,
  className,
  fallback,
}: {
  artPath?: string | null;
  src?: string | null;
  label: string;
  size?: "mini" | "large";
  index?: number;
  className?: string;
  fallback?: ReactNode;
}) {
  const resolvedClassName = className ?? (size === "mini" ? "mini-cover" : "cover");
  const imageSrc = src ?? (artPath ? convertFileSrc(artPath) : null);

  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  useEffect(() => {
    setFailedSrc(null);
  }, [imageSrc]);

  const showImage = Boolean(imageSrc) && failedSrc !== imageSrc;

  return (
    <div className={resolvedClassName} style={{ "--accent-index": index % 6 } as CSSProperties}>
      {showImage && imageSrc ? (
        <img
          src={imageSrc}
          alt=""
          draggable={false}
          onError={() => setFailedSrc(imageSrc)}
        />
      ) : fallback ?? <span>{initials(label)}</span>}
    </div>
  );
}
