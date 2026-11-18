import { type Kysely, sql } from "kysely";

import type { Database } from "../db/schema.ts";
import type { NewEvent } from "./event-store.ts";

/** How often one process records a project's latest event at most. */
export const LAST_EVENT_INTERVAL_MS = 60 * 1000;

/**
 * Records when each project's latest event happened (projects.last_event_at),
 * which the dashboard shows, after its events are stored. One update per
 * project a minute at most in each process, so a busy site costs PostgreSQL
 * one statement a minute, not one per request; a project's first events in
 * a process are recorded at once. The time can trail by up to that minute.
 *
 * greatest() keeps the latest time whatever order requests finish in, and
 * makes a repeat harmless; a deleted project is simply not updated.
 */
export class LastEventRecorder {
  readonly #db: Kysely<Database>;
  readonly #now: () => number;
  /** When this process last recorded each project's time. */
  readonly #recorded = new Map<string, number>();

  constructor(db: Kysely<Database>, { now = Date.now }: { now?: () => number } = {}) {
    this.#db = db;
    this.#now = now;
  }

  /** Records the latest of `events`, unless this project's was recorded less than a minute ago. */
  async record(projectId: string, events: readonly NewEvent[]): Promise<void> {
    if (events.length === 0) return;
    const now = this.#now();
    const last = this.#recorded.get(projectId);
    if (last !== undefined && now - last < LAST_EVENT_INTERVAL_MS) return;
    // Taken before the update waits, so requests finishing together make one update.
    this.#recorded.set(projectId, now);
    const latest = new Date(Math.max(...events.map((event) => event.occurredAt.getTime())));
    try {
      await this.#db
        .updateTable("projects")
        .set({ last_event_at: sql<Date>`greatest(last_event_at, ${latest})` })
        .where("id", "=", projectId)
        .execute();
    } catch (error) {
      // The next request tries again.
      this.#recorded.delete(projectId);
      throw error;
    }
  }
}
