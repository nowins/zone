import { APP_VERSION, APP_BUILD_ID } from "../app/releaseInfo.js";

export type DiagnosticEvent = {
  domain: "music" | "podcast" | "library" | "visualizer";
  event: string;
  outcome?: "ok" | "error";
  code?: number;
  elapsedMs?: number;
  attempt?: number;
};
const KEY = "zone-diagnostics-v1";
const LIMIT = 200;
type Entry = DiagnosticEvent & { at: string };

function readEntries(): Entry[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.slice(-LIMIT).flatMap(item => {
      const sanitized = sanitizeEntry(item); return sanitized ? [sanitized] : [];
    }) : [];
  } catch { return []; }
}

function sanitizeEntry(value: unknown): Entry | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<Entry>;
  if (!['music', 'podcast', 'library', 'visualizer'].includes(item.domain ?? '')
    || typeof item.event !== "string" || !/^[a-z][a-z0-9_]{0,63}$/i.test(item.event)
    || typeof item.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.at) || !Number.isFinite(Date.parse(item.at))) return null;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e9 ? Math.round(value) : undefined;
  return { at: item.at, domain: item.domain!, event: item.event, outcome: item.outcome === "ok" || item.outcome === "error" ? item.outcome : undefined,
    code: number(item.code), elapsedMs: number(item.elapsedMs), attempt: number(item.attempt) };
}

export function recordDiagnostic(value: DiagnosticEvent) {
  try {
    // Accept structured facts only. Never store raw errors, paths or feed URLs.
    const entry = sanitizeEntry({ ...value, at: new Date().toISOString() });
    if (!entry) return;
    localStorage.setItem(KEY, JSON.stringify([...readEntries(), entry].slice(-LIMIT)));
  } catch { /* Diagnostics must never interrupt playback or persistence. */ }
}

export function exportDiagnostics() {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const webviewVersion = agent.match(/Edg\/([\d.]+)/)?.[1] ?? agent.match(/Chrome\/([\d.]+)/)?.[1] ?? "unknown";
  return JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), environment: {
    appVersion: APP_VERSION, buildId: APP_BUILD_ID, platform: typeof navigator === "undefined" ? "unknown" : navigator.platform || "unknown",
    runtime: typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? "tauri" : "browser", webviewVersion,
  }, events: readEntries() }, null, 2);
}
