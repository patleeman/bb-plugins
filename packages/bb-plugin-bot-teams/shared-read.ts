/** Coalesce simultaneous reads from separately mounted BB slots. No stale result cache. */
export class SharedReads {
  private pending = new Map<string, Promise<unknown>>();
  private revision: unknown;
  invalidate(revision?: unknown) {
    if (revision !== undefined && this.revision === revision) return;
    this.revision = revision;
    this.pending.clear();
  }
  read<T>(key: string, read: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    // Start next microtask so a single realtime event can reach all mounted slots.
    const result = Promise.resolve().then(read);
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => {});
    return result;
  }
}
export const sharedReads = new SharedReads();
