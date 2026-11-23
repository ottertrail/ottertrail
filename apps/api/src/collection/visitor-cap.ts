/**
 * Caps runaway trackers and scripts at 5,000 events per visitor per day
 * (docs/web-analytics.md, "A daily cap per visitor").
 */
export const VISITOR_DAILY_EVENT_CAP = 5_000;

/** The most visitors counted at once: about 15 MB at most. */
export const VISITOR_CAP_MAX_KEYS = 100_000;

/**
 * Counts by project, local day, and visitor ID in process memory.
 * LRU eviction at maxKeys lets forgotten visitors spend the full cap again.
 * Restarts clear counts, and each API process counts independently.
 */
export class VisitorCap {
  readonly #cap: number;
  readonly #maxKeys: number;
  readonly #counts = new Map<string, number>();

  constructor({
    cap = VISITOR_DAILY_EVENT_CAP,
    maxKeys = VISITOR_CAP_MAX_KEYS,
  }: { cap?: number; maxKeys?: number } = {}) {
    this.#cap = cap;
    this.#maxKeys = maxKeys;
  }

  /** Returns false at the daily cap; the caller must discard the event. */
  take(projectId: string, day: string, visitorId: string): boolean {
    const key = `${projectId} ${day} ${visitorId}`;
    const count = this.#counts.get(key) ?? 0;
    // Refresh LRU order.
    this.#counts.delete(key);
    this.#counts.set(key, Math.min(count + 1, this.#cap + 1));
    while (this.#counts.size > this.#maxKeys) {
      const oldest = this.#counts.keys().next().value;
      if (oldest === undefined) break;
      this.#counts.delete(oldest);
    }
    return count < this.#cap;
  }

  /** Refund an event that was not stored. */
  untake(projectId: string, day: string, visitorId: string): void {
    const key = `${projectId} ${day} ${visitorId}`;
    const count = this.#counts.get(key);
    if (count !== undefined && count > 0) this.#counts.set(key, count - 1);
  }
}
