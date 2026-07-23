export type LyricsProviderSearchStrategy = "priority-fallback" | "all";

export type LyricsProviderSearchTask<T> = {
  providerId: string;
  providerName: string;
  run: () => Promise<T[]>;
};

export type LyricsProviderTaskError = {
  providerId: string;
  providerName: string;
  message: string;
};

export type LyricsProviderTaskOutcome = {
  providerId: string;
  providerName: string;
  status: "ready" | "empty" | "error";
  candidateCount: number;
  message?: string;
};

type LyricsProviderTaskResult<T> = {
  candidates: T[];
  errors: LyricsProviderTaskError[];
  outcomes: LyricsProviderTaskOutcome[];
};

export async function runLyricsProviderSearchTasks<T>(
  tasks: LyricsProviderSearchTask<T>[],
  strategy: LyricsProviderSearchStrategy,
  signal: AbortSignal,
  hasHighConfidenceResult: (candidates: T[]) => boolean,
): Promise<LyricsProviderTaskResult<T>> {
  if (strategy === "all") {
    const results = await Promise.all(tasks.map((task) => runTask(task, signal)));
    return results.reduce<LyricsProviderTaskResult<T>>(
      (combined, result) => ({
        candidates: [...combined.candidates, ...result.candidates],
        errors: [...combined.errors, ...result.errors],
        outcomes: [...combined.outcomes, ...result.outcomes],
      }),
      { candidates: [], errors: [], outcomes: [] },
    );
  }

  const combined: LyricsProviderTaskResult<T> = { candidates: [], errors: [], outcomes: [] };
  for (const task of tasks) {
    const result = await runTask(task, signal);
    combined.candidates.push(...result.candidates);
    combined.errors.push(...result.errors);
    combined.outcomes.push(...result.outcomes);
    if (hasHighConfidenceResult(result.candidates)) break;
  }
  return combined;
}

async function runTask<T>(
  task: LyricsProviderSearchTask<T>,
  signal: AbortSignal,
): Promise<LyricsProviderTaskResult<T>> {
  if (signal.aborted) throw abortError();
  try {
    const candidates = await task.run();
    return {
      candidates,
      errors: [],
      outcomes: [{
        providerId: task.providerId,
        providerName: task.providerName,
        status: candidates.length > 0 ? "ready" : "empty",
        candidateCount: candidates.length,
      }],
    };
  } catch (error) {
    if (signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      candidates: [],
      errors: [{
        providerId: task.providerId,
        providerName: task.providerName,
        message,
      }],
      outcomes: [{
        providerId: task.providerId,
        providerName: task.providerName,
        status: "error",
        candidateCount: 0,
        message,
      }],
    };
  }
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}
