/**
 * A least-recently-used map bounded by estimated bytes, not by entry count (the ledger rules): one 10× org is about 42 MB
 * of isolate memory, while eight typical companies fit in the same budget, so a count limit would be
 * wrong in both directions. An entry larger than the whole budget is served but never kept.
 */
export class ByteBoundedLru<V> {
  private readonly entries = new Map<string, { value: V; bytes: number }>();
  private total = 0;

  constructor(readonly maxBytes: number) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Re-inserting moves the key to the end of the Map's iteration order: the most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Stores the value (or refreshes its size) and evicts the least recently used entries over the budget. */
  set(key: string, value: V, bytes: number): boolean {
    this.delete(key);
    if (bytes > this.maxBytes) return false;
    this.entries.set(key, { value, bytes });
    this.total += bytes;
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.total -= entry.bytes;
    }
    return this.entries.has(key);
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.bytes;
  }

  /** Drops every key that matches, e.g. the older heads of an org once a newer head is loaded. */
  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) if (predicate(key)) this.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.total;
  }
}
