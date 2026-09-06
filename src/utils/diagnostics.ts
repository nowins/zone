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
    return Array.isArray(value) ? value.slice(-LIMIT) : [];
  } catch { return []; }
}

export function recordDiagnostic(value: DiagnosticEvent) {
  try {
    // Accept structured facts only. Never store raw errors, paths or feed URLs.
    const entry: Entry = { at: new Date().toISOString(), domain: value.domain,
      event: value.event, outcome: value.outcome, code: value.code,
      elapsedMs: value.elapsedMs === undefined ? undefined : Math.round(value.elapsedMs), attempt: value.attempt };
    localStorage.setItem(KEY, JSON.stringify([...readEntries(), entry].slice(-LIMIT)));
  } catch { /* Diagnostics must never interrupt playback or persistence. */ }
}

export function exportDiagnostics() {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), events: readEntries() }, null, 2);
}
