import type { RepeatMode } from "../types";

export type QueueInsertMode = "play_next" | "append_end";

export type QueueMoveResult =
  | { kind: "move"; trackId: string }
  | { kind: "restart"; trackId: string }
  | { kind: "boundary" }
  | { kind: "empty" };

export function playbackSourceKey(track: { id: string; path: string } | null) {
  return track ? `${track.id}\0${track.path}` : null;
}

export function createShuffleOrder(
  queue: string[],
  activeTrackId: string | null,
  random: () => number = Math.random,
) {
  const remaining = [...queue];
  const activeIndex = activeTrackId ? remaining.indexOf(activeTrackId) : -1;
  if (activeIndex >= 0) remaining.splice(activeIndex, 1);

  for (let index = remaining.length - 1; index > 0; index -= 1) {
    const sample = Math.min(0.999999, Math.max(0, random()));
    const target = Math.floor(sample * (index + 1));
    [remaining[index], remaining[target]] = [remaining[target], remaining[index]];
  }

  return activeTrackId && activeIndex >= 0
    ? [activeTrackId, ...remaining]
    : remaining;
}

export function resolveQueueMove(
  queue: string[],
  activeTrackId: string | null,
  delta: 1 | -1,
  repeat: RepeatMode,
): QueueMoveResult {
  if (queue.length === 0) return { kind: "empty" };

  const currentIndex = queue.indexOf(activeTrackId ?? "");
  if (currentIndex < 0) {
    return {
      kind: "move",
      trackId: delta === 1 ? queue[0] : queue[queue.length - 1],
    };
  }

  let nextIndex = currentIndex + delta;
  if (nextIndex < 0 || nextIndex >= queue.length) {
    if (repeat !== "all") return { kind: "boundary" };
    nextIndex = (nextIndex + queue.length) % queue.length;
  }

  const trackId = queue[nextIndex];
  return trackId === activeTrackId
    ? { kind: "restart", trackId }
    : { kind: "move", trackId };
}

export function queueAfterCurrent<T extends { id: string }>(queue: T[], activeTrackId: string | null) {
  if (queue.length === 0) return [];
  const currentIndex = queue.findIndex((item) => item.id === activeTrackId);
  if (currentIndex < 0) return queue;
  return [...queue.slice(currentIndex + 1), ...queue.slice(0, currentIndex)];
}

export function haveSameQueueItems(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const id of left) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of right) {
    const count = counts.get(id) ?? 0;
    if (count === 0) return false;
    if (count === 1) counts.delete(id);
    else counts.set(id, count - 1);
  }
  return counts.size === 0;
}

export function reconcileQueueWithLibrary(queue: string[], libraryIds: string[]) {
  const validIds = new Set(libraryIds);
  const preserved = queue.filter((id) => validIds.has(id));
  if (preserved.length === queue.length && (queue.length > 0 || libraryIds.length === 0)) return queue;
  return preserved.length > 0 ? preserved : [...libraryIds];
}

export function reconcileActiveTrack(
  activeTrackId: string | null,
  queue: string[],
  libraryIds: string[],
) {
  const validIds = new Set(libraryIds);
  if (activeTrackId && validIds.has(activeTrackId)) return activeTrackId;
  return queue.find((id) => validIds.has(id)) ?? libraryIds[0] ?? null;
}


export function insertTracksIntoQueue(
  queue: string[],
  activeTrackId: string | null,
  trackIds: string[],
  mode: QueueInsertMode,
) {
  const incoming = uniqueQueueIds(trackIds);
  if (incoming.length === 0) return queue;

  if (mode === "append_end") {
    return uniqueQueueIds([...queue, ...incoming]);
  }

  // play_next: insert after current track; if current missing, prepend.
  const withoutIncoming = queue.filter((id) => !incoming.includes(id));
  const currentIndex = activeTrackId ? withoutIncoming.indexOf(activeTrackId) : -1;
  if (currentIndex < 0) {
    return uniqueQueueIds([...incoming, ...withoutIncoming]);
  }
  return [
    ...withoutIncoming.slice(0, currentIndex + 1),
    ...incoming,
    ...withoutIncoming.slice(currentIndex + 1),
  ];
}

export function resolvePreviousAction(
  currentTimeSeconds: number,
  adaptivePrevious: boolean,
  thresholdSeconds = 3,
): "restart" | "previous" {
  if (!adaptivePrevious) return "previous";
  return currentTimeSeconds > thresholdSeconds ? "restart" : "previous";
}

function uniqueQueueIds(ids: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}
