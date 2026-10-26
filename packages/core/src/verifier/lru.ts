/** A size-bounded map that evicts the least recently used entry. */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();

  constructor(readonly capacity: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, value);
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
