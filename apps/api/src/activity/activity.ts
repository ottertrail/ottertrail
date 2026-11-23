import { type Kysely, sql } from "kysely";

import type { Database } from "../db/schema.ts";

/**
 * Ingestion activity (docs/dashboard.md, "Activity"): how many requests each
 * project's ingestion routes accepted, filtered, and refused, and why, for
 * the Activity tab of its settings. Counts only: never a request's
 * contents, address, user agent, key, or path.
 *
 * A route adds to a counter in memory, keyed by project, hour, source, and
 * outcome: no lookup, no database work. A flusher writes the counters to
 * PostgreSQL every 15 seconds, and once more when the API closes, adding
 * them to what is there, so several API processes add up. PostgreSQL, not
 * ClickHouse: "ClickHouse could not store it" must be counted while
 * ClickHouse is down.
 *
 * Only what can be tied to a project is counted: a request refused before
 * its key names a project (an unknown key, a body too large or malformed
 * before the key is read, an address over its rate) is not, and no lookup
 * is added to find one.
 */

export const INGEST_SOURCES = [
  "browser_events",
  "server_events",
  "errors",
  "web_vitals",
  "replays",
  "heatmaps",
  "traces",
  "logs",
  "metrics",
  "ai_calls",
  "source_maps",
] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

/** What happened to a request, once its project was known. */
export const INGEST_OUTCOMES = [
  /** Stored (or acknowledged once its write was), or a retry of what was. */
  "accepted",
  /** Dropped as a bot, or a browser at a data center's address. */
  "filtered_bot",
  /** Dropped: a blocked address, referrer spam, or a visitor past its daily cap. */
  "filtered_spam",
  /** Dropped: it happened too long before it was sent (normalize.ts, MAX_EVENT_AGE_MS). */
  "filtered_too_old",
  /** The page's site is not in the project's Allowed sites. */
  "refused_origin",
  /** The feature is off for the project, or the instance has no object store for it. */
  "refused_disabled",
  /** The body is not valid, once the project is known. */
  "refused_invalid",
  /** The project's own rate limit, or its requests in progress. */
  "refused_rate_limited",
  /** The instance's limit for all projects together, or a storage budget. */
  "refused_volume",
  /** ClickHouse, PostgreSQL, or the object store could not take the write: 503. */
  "refused_unavailable",
] as const;
export type IngestOutcome = (typeof INGEST_OUTCOMES)[number];

/** How often each process writes its counts. */
export const ACTIVITY_FLUSH_INTERVAL_MS = 15_000;
/** Counters held at once; past it, new keys are dropped until the next flush. */
export const ACTIVITY_MAX_KEYS = 20_000;
/** Days the counts are kept: the worker deletes older hours daily. */
export const ACTIVITY_RETENTION_DAYS = 7;
/** Rows per statement: 7 parameters each, well inside PostgreSQL's 65,535. */
const ROWS_PER_STATEMENT = 1_000;

const HOUR_MS = 60 * 60 * 1000;

interface Counter {
  projectId: string;
  /** The start of the hour, in milliseconds since 1970 (UTC hours). */
  hour: number;
  source: IngestSource;
  outcome: IngestOutcome;
  count: number;
  items: number;
  /** When the latest request arrived, in milliseconds since 1970. */
  lastAt: number;
}

export interface IngestActivityOptions {
  now?: () => number;
  maxKeys?: number;
  flushIntervalMs?: number;
  warn?: (message: string, fields: Record<string, unknown>) => void;
}

/**
 * The counters of one API process, and their flusher. `add` is O(1) and
 * never waits. A flush that fails keeps its counts and adds them to the
 * next one; a flush past the key cap drops new keys and warns once.
 */
export class IngestActivity {
  readonly #db: Kysely<Database>;
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #flushIntervalMs: number;
  readonly #warn: (message: string, fields: Record<string, unknown>) => void;
  #counters = new Map<string, Counter>();
  #dropped = 0;
  /** Share an active flush to prevent duplicate writes. */
  #flushing: Promise<void> | null = null;

  constructor(db: Kysely<Database>, options: IngestActivityOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#maxKeys = options.maxKeys ?? ACTIVITY_MAX_KEYS;
    this.#flushIntervalMs = options.flushIntervalMs ?? ACTIVITY_FLUSH_INTERVAL_MS;
    this.#warn = options.warn ?? (() => undefined);
  }

  get size(): number {
    return this.#counters.size;
  }

  /** items is 0 when the route does not know the count. */
  add(projectId: string, source: IngestSource, outcome: IngestOutcome, items = 0): void {
    const now = this.#now();
    const hour = now - (now % HOUR_MS);
    const key = `${projectId} ${hour} ${source} ${outcome}`;
    const counter = this.#counters.get(key);
    if (counter !== undefined) {
      counter.count += 1;
      counter.items += items;
      counter.lastAt = Math.max(counter.lastAt, now);
      return;
    }
    if (this.#counters.size >= this.#maxKeys) {
      this.#dropped += 1;
      return;
    }
    this.#counters.set(key, { projectId, hour, source, outcome, count: 1, items, lastAt: now });
  }

  /**
   * Writes the counts and clears them. What a statement could not write
   * stays, added to what comes meanwhile, for the next flush; the error
   * is thrown.
   */
  async flush(): Promise<void> {
    // Serialize flushes so slow writes cannot double-count.
    while (this.#flushing !== null) await this.#flushing.catch(() => undefined);
    const flushing = this.#write();
    this.#flushing = flushing;
    try {
      await flushing;
    } finally {
      this.#flushing = null;
    }
  }

  async #write(): Promise<void> {
    if (this.#dropped > 0) {
      this.#warn("ingestion activity: too many counters at once, some requests were not counted", {
        dropped: this.#dropped,
        maxKeys: this.#maxKeys,
      });
      this.#dropped = 0;
    }
    if (this.#counters.size === 0) return;
    // Match lock order across processes to prevent deadlocks.
    const pending = [...this.#counters.values()].toSorted(byKey);
    this.#counters = new Map();
    for (let start = 0; start < pending.length; start += ROWS_PER_STATEMENT) {
      const rows = pending.slice(start, start + ROWS_PER_STATEMENT);
      try {
        await upsert(this.#db, rows);
      } catch (error) {
        this.#keep(pending.slice(start));
        throw error;
      }
    }
  }

  /**
   * Merge unwritten counters with new ones within the cap to bound outage memory.
   * Drop hours beyond 7 days, as the worker would. Warn once at the next flush.
   */
  #keep(counters: readonly Counter[]): void {
    const oldest = activityWindows(new Date(this.#now())).week.getTime();
    for (const kept of counters) {
      const key = `${kept.projectId} ${kept.hour} ${kept.source} ${kept.outcome}`;
      const counter = this.#counters.get(key);
      if (kept.hour < oldest) {
        this.#dropped += kept.count;
      } else if (counter === undefined) {
        if (this.#counters.size >= this.#maxKeys) this.#dropped += kept.count;
        else this.#counters.set(key, kept);
      } else {
        counter.count += kept.count;
        counter.items += kept.items;
        counter.lastAt = Math.max(counter.lastAt, kept.lastAt);
      }
    }
  }

  /** Flushes every interval until the returned function stops it; a failure is logged and retried. */
  start(): () => void {
    const timer = setInterval(() => {
      this.flush().catch((error: unknown) => {
        this.#warn("ingestion activity: could not write the counts; kept for the next try", {
          err: String(error),
        });
      });
    }, this.#flushIntervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }
}

/** Text in code-unit order, as PostgreSQL's "C" collation and a UUID's bytes sort. */
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function byKey(a: Counter, b: Counter): number {
  return (
    compareText(a.projectId, b.projectId) ||
    a.hour - b.hour ||
    compareText(a.source, b.source) ||
    compareText(a.outcome, b.outcome)
  );
}

/** Skip deleted projects so one deletion cannot keep every later flush failing. */
async function upsert(db: Kysely<Database>, rows: readonly Counter[]): Promise<void> {
  const values = sql.join(
    rows.map(
      (row) =>
        sql`(${row.projectId}::uuid, ${new Date(row.hour)}::timestamptz, ${row.source}::text, ${row.outcome}::text, ${row.count}::bigint, ${row.items}::bigint, ${new Date(row.lastAt)}::timestamptz)`,
    ),
  );
  await sql`
    insert into ingest_activity as a (project_id, hour, source, outcome, count, items, last_at)
    select v.project_id, v.hour, v.source, v.outcome, v.count, v.items, v.last_at
    from (values ${values}) as v (project_id, hour, source, outcome, count, items, last_at)
    join projects p on p.id = v.project_id
    -- Rows locked in key order, whatever the join's plan: no deadlock between processes.
    order by v.project_id, v.hour, v.source collate "C", v.outcome collate "C"
    on conflict (project_id, hour, source, outcome) do update set
      count = a.count + excluded.count,
      items = a.items + excluded.items,
      last_at = greatest(a.last_at, excluded.last_at)
  `.execute(db);
}

/**
 * Windows start on UTC hour boundaries: the current hour and the 24 and 168
 * whole hours ending with it. Stored hourly counts cannot split an hour.
 */
export function activityWindows(now: Date): { hour: Date; day: Date; week: Date } {
  const hour = now.getTime() - (now.getTime() % HOUR_MS);
  return {
    hour: new Date(hour),
    day: new Date(hour - 23 * HOUR_MS),
    week: new Date(hour - (ACTIVITY_RETENTION_DAYS * 24 - 1) * HOUR_MS),
  };
}

/** Deletes the hours before the 7 days' window; the worker runs it daily. */
export async function pruneIngestActivity(db: Kysely<Database>, now = new Date()): Promise<number> {
  const result = await db
    .deleteFrom("ingest_activity")
    .where("hour", "<", activityWindows(now).week)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

export interface ActivityCount {
  count: number;
  items: number;
}

export interface SourceActivity {
  source: IngestSource;
  /** When the latest accepted request arrived in the 7 days; null when none did. */
  lastAcceptedAt: string | null;
  /** Each outcome with any count in the 7 days, by window. */
  outcomes: Partial<
    Record<
      IngestOutcome,
      { hour: ActivityCount; day: ActivityCount; week: ActivityCount; lastAt: string }
    >
  >;
}

/**
 * A project's counts for this hour, the 24 hours, and the 7 days that end
 * with it (activityWindows), every source listed.
 */
export async function readIngestActivity(
  db: Kysely<Database>,
  projectId: string,
  now: Date,
): Promise<SourceActivity[]> {
  const since = activityWindows(now);
  const { rows } = await sql<{
    source: IngestSource;
    outcome: IngestOutcome;
    hour_count: string;
    hour_items: string;
    day_count: string;
    day_items: string;
    week_count: string;
    week_items: string;
    last_at: Date;
  }>`
    select source, outcome,
      coalesce(sum(count) filter (where hour >= ${since.hour}), 0) as hour_count,
      coalesce(sum(items) filter (where hour >= ${since.hour}), 0) as hour_items,
      coalesce(sum(count) filter (where hour >= ${since.day}), 0) as day_count,
      coalesce(sum(items) filter (where hour >= ${since.day}), 0) as day_items,
      sum(count) as week_count,
      sum(items) as week_items,
      max(last_at) as last_at
    from ingest_activity
    where project_id = ${projectId} and hour >= ${since.week}
    group by source, outcome
  `.execute(db);
  const bySource = new Map<IngestSource, SourceActivity>(
    INGEST_SOURCES.map((source) => [source, { source, lastAcceptedAt: null, outcomes: {} }]),
  );
  for (const row of rows) {
    const activity = bySource.get(row.source);
    if (activity === undefined) continue;
    const lastAt = new Date(row.last_at).toISOString();
    activity.outcomes[row.outcome] = {
      hour: { count: Number(row.hour_count), items: Number(row.hour_items) },
      day: { count: Number(row.day_count), items: Number(row.day_items) },
      week: { count: Number(row.week_count), items: Number(row.week_items) },
      lastAt,
    };
    if (row.outcome === "accepted") activity.lastAcceptedAt = lastAt;
  }
  return [...bySource.values()];
}
