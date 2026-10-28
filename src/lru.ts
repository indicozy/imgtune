/** A map that keeps at most `max` entries, dropping the least recently used one when it is full. */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly max: number) {}

  get size(): number {
    return this.entries.size;
  }

  /** The value for `key`, which becomes the most recently used; undefined when absent. */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as K;
      this.entries.delete(oldest);
    }
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
