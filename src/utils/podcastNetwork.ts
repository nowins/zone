import { invoke } from "@tauri-apps/api/core";

export function newPodcastNetworkRequestId() {
  return crypto.randomUUID();
}

export function cancelPodcastNetworkRequest(requestId: string) {
  return invoke<void>("podcast_cancel_network_request", { requestId });
}

export function podcastProtocolRequestUrl(url: string, requestId: string) {
  return `${url}${url.includes("?") ? "&" : "?"}requestId=${requestId}`;
}

export function isPodcastArtworkProtocol(url: string | null) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "zone-podcast-artwork:"
      || (parsed.protocol === "http:" && parsed.hostname === "zone-podcast-artwork.localhost");
  } catch { return false; }
}
