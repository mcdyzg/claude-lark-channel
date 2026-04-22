export class Dedup {
  private seenMap = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true if this id was seen within the ttl window (i.e. is a duplicate). */
  seen(id: string): boolean {
    const t = this.now();
    const last = this.seenMap.get(id);
    if (last !== undefined && t - last < this.ttlMs) return true;
    this.seenMap.set(id, t);
    return false;
  }

  sweep(): void {
    const t = this.now();
    for (const [id, ts] of this.seenMap) {
      if (t - ts >= this.ttlMs) this.seenMap.delete(id);
    }
  }

  size(): number {
    return this.seenMap.size;
  }
}
