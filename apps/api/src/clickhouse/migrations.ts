/**
 * ClickHouse's tables, in order, as PostgreSQL's are in db/migrations/.
 * Each migration is a list of statements for one database, named by the
 * caller. A migration that has run is recorded in its schema_migrations
 * table and never runs again, so never change one: add the next.
 */
export interface ClickHouseMigration {
  name: string;
  statements: (database: string) => string[];
}

export const CLICKHOUSE_MIGRATIONS: ClickHouseMigration[] = [
  {
    /**
     * Analytics events, as PostgreSQL's events table has them (db/schema.ts).
     * PostgreSQL still receives them first; the worker copies them here.
     *
     * - Ordered by project, then time: one project's range is one
     *   contiguous read, and every query filters by project first.
     * - Partitioned by month: retention drops whole months where it can.
     * - ReplacingMergeTree keeps one row per (project_id, occurred_at,
     *   event_id) when parts merge. The worker sends each event once, so this
     *   only matters if a batch is sent twice after a crash, and the insert
     *   deduplication window already drops a repeated batch (tested).
     * - LowCardinality for columns with few distinct values: smaller and faster.
     */
    name: "0001_create_events",
    statements: (database) => [
      `CREATE TABLE IF NOT EXISTS ${database}.events (
        project_id UUID,
        event_id UUID,
        name LowCardinality(String),
        occurred_at DateTime64(3, 'UTC'),
        received_at DateTime64(3, 'UTC'),
        path String,
        referrer Nullable(String),
        utm_source LowCardinality(Nullable(String)),
        utm_medium LowCardinality(Nullable(String)),
        utm_campaign LowCardinality(Nullable(String)),
        utm_term Nullable(String),
        utm_content Nullable(String),
        properties String,
        browser LowCardinality(Nullable(String)),
        browser_version LowCardinality(Nullable(String)),
        os LowCardinality(Nullable(String)),
        device_type LowCardinality(Nullable(String)),
        country LowCardinality(Nullable(String)),
        region LowCardinality(Nullable(String)),
        city LowCardinality(Nullable(String)),
        visitor_id Nullable(Int64)
      )
      ENGINE = ReplacingMergeTree
      PARTITION BY toYYYYMM(occurred_at)
      ORDER BY (project_id, occurred_at, event_id)
      SETTINGS non_replicated_deduplication_window = 1000`,
    ],
  },
];
