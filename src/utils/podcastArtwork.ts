import { convertFileSrc } from "@tauri-apps/api/core";

const PODCAST_ARTWORK_URL_LIMIT = 4 * 1024;

export function podcastArtworkSrc(remoteUrl?: string | null): string | null {
  if (!remoteUrl) return null;
  const bytes = new TextEncoder().encode(remoteUrl);
  if (bytes.length === 0 || bytes.length > PODCAST_ARTWORK_URL_LIMIT) return null;

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const token = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return convertFileSrc(token, "zone-podcast-artwork");
}
