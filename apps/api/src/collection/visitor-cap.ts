/**
 * The most events one visitor ID may store in its day (docs/web-analytics.md,
 * "A daily cap per visitor"). A person browsing a site sends a few dozen
 * to a few hundred; 5,000 is past any visit, and is reached only by a
 * runaway tracker (a page in a loop) or a script.
 */
export const VISITOR_DAILY_EVENT_CAP = 5_000;

/** The most visitors counted at once: about 15 MB at most. */
export const VISITOR_CAP_MAX_KEYS = 100_000;

/**
 * Counts each visitor's events per day, in this process's memory: nothing
 * is stored, and nothing is looked up before an insert. Keyed by project,
 * the visitor's day in the instance's timezone, and visitor ID.
 *
 * Memory is bounded: past `maxKeys` visitors, the one counted least
 * recently is forgotten. A forgotten visitor starts again from zero, so it
 * may store another full day's cap; only a flood of distinct visitors,
 * which the per-IP limits bound, forgets one that is still sending. A
 * restart forgets every count, and each API process counts its own.
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

  /**
   * Counts one event of a visitor on a day; false when the visitor has
   * already stored the cap that day, and the event must not be stored.
   */
  take(projectId: string, day: string, visitorId: string): boolean {
    const key = `${projectId} ${day} ${visitorId}`;
    const count = this.#counts.get(key) ?? 0;
    // Re-inserted, so the Map's order is least recently counted first.
    this.#counts.delete(key);
    this.#counts.set(key, Math.min(count + 1, this.#cap + 1));
    while (this.#counts.size > this.#maxKeys) {
      const oldest = this.#counts.keys().next().value;
      if (oldest === undefined) break;
      this.#counts.delete(oldest);
    }
    return count < this.#cap;
  }

  /** Takes back one event counted by take(), for events that were not stored after all. */
  untake(projectId: string, day: string, visitorId: string): void {
    const key = `${projectId} ${day} ${visitorId}`;
    const count = this.#counts.get(key);
    if (count !== undefined && count > 0) this.#counts.set(key, count - 1);
  }
}
