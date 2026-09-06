type StorageAccess = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Keep the original recoverable until the import's committed snapshot is read. */
export async function migrateLegacyState<T>(
  storage: StorageAccess,
  key: string,
  importState: (state: unknown) => Promise<T>,
): Promise<T | null> {
  const raw = storage.getItem(key);
  if (!raw) return null;
  const state: unknown = JSON.parse(raw);
  const snapshot = await importState(state);
  // The native importer returns its read-back snapshot only after commit.
  // Preserve the original even after success for manual recovery.
  storage.setItem(`${key}-backup`, raw);
  storage.removeItem(key);
  return snapshot;
}
