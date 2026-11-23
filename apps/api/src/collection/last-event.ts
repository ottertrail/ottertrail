import { type Kysely, sql } from "kysely";

import type { Database } from "../db/schema.ts";
import type { NewEvent } from "./event-store.ts";

/** How often one process records a project's latest event at most. */
export const LAST_EVENT_INTERVAL_MS = 60 * 1000;

/**
 * Records projects.last_event_at after storage, at most once per project per minute
 * in each process. The first batch updates immediately; later times can lag a minute.
 * greatest() handles retries and requests completing out of order.
 */
export class LastEventRecorder {
  readonly #db: Kysely<Database>;
  readonly #now: () => number;
  readonly #recorded = new Map<string, number>();

  constructor(db: Kysely<Database>, { now = Date.now }: { now?: () => number } = {}) {
    this.#db = db;
    this.#now = now;
  }

  async record(projectId: string, events: readonly NewEvent[]): Promise<void> {
    if (events.length === 0) return;
    const now = this.#now();
    const last = this.#recorded.get(projectId);
    if (last !== undefined && now - last < LAST_EVENT_INTERVAL_MS) return;
    // Reserve before awaiting so concurrent requests share one update.
    this.#recorded.set(projectId, now);
    const latest = new Date(Math.max(...events.map((event) => event.occurredAt.getTime())));
    try {
      await this.#db
        .updateTable("projects")
        .set({ last_event_at: sql<Date>`greatest(last_event_at, ${latest})` })
        .where("id", "=", projectId)
        .execute();
    } catch (error) {
      // Allow the next request to retry.
      this.#recorded.delete(projectId);
      throw error;
    }
  }
}
