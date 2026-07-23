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

type LyricsProviderTaskResult<T> = {
  candidates: T[];
  errors: LyricsProviderTaskError[];
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
      }),
      { candidates: [], errors: [] },
    );
  }

  const combined: LyricsProviderTaskResult<T> = { candidates: [], errors: [] };
  for (const task of tasks) {
    const result = await runTask(task, signal);
    combined.candidates.push(...result.candidates);
    combined.errors.push(...result.errors);
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
    return { candidates: await task.run(), errors: [] };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      candidates: [],
      errors: [{
        providerId: task.providerId,
        providerName: task.providerName,
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}
